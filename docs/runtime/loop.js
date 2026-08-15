// Agent loop. There used to be one loop per wire format here — Claude's
// content blocks, OpenAI's chat-completions deltas, and termd. Only termd is
// left, and it is the inverted one: the loop runs on the operator's machine and
// calls back into the page, so this file no longer drives a conversation. It
// answers one.

import { streamTermdAgent, answerTermdTool, answerTermdPermission, parseTermdStream } from './providers.js';
import {
  appendMessage, appendDivider, appendToolMsg,
  createPendingToolCard, resolveToolCard,
  createQuestionCard,
  hideSpinner, showSpinner,
} from './chat.js';
import { showConfirmDialog, scrollDisplayIntoView, renderMarkdown } from './ui.js';
import { listTools } from './tools.js';
import { getSelectedModelName } from './auth.js';

// Trust gate: prompt the user only for tools annotated as actually
// destructive. The previous gate fired on the absence of `readOnlyHint`,
// which meant any tool that hit an external API but wasn't explicitly marked
// read-only got a confirm prompt for no reason.
async function requestPermission(toolDef, args) {
  if (toolDef.destructiveHint === true) {
    return showConfirmDialog(toolDef.title || toolDef.name, args);
  }
  return true;
}

function findTool(name) {
  return listTools().find(t => t.name === name);
}

async function executeTool(name, input, pendingEl, getDividerContext) {
  const def = findTool(name);
  if (!def) {
    const result = { error: `Unknown tool: ${name}` };
    if (pendingEl) resolveToolCard(pendingEl, name, input, result.error, true);
    else appendToolMsg(name, input, result.error, true);
    return result;
  }

  const ok = await requestPermission(def, input);
  if (!ok) {
    const result = { summary: `User declined: ${def.title || def.name}` };
    if (pendingEl) resolveToolCard(pendingEl, name, input, result.summary, true);
    else appendToolMsg(name, input, result.summary, true);
    return result;
  }

  let result;
  try {
    // Pass a minimal client conforming to the WebMCP spec interaction shape.
    // requestUserInteraction lets a tool open a confirm/prompt dialog from
    // within its exec without the runtime baking in which one to call.
    const client = { requestUserInteraction: (cb) => cb() };
    result = await def.exec(input, client);
  } catch (err) {
    result = { error: err.message || String(err) };
    if (pendingEl) resolveToolCard(pendingEl, name, input, result.error, true);
    else appendToolMsg(name, input, result.error, true);
    return result;
  }

  const summary = result?.summary ?? '';
  if (pendingEl) resolveToolCard(pendingEl, name, input, summary, false);
  else appendToolMsg(name, input, summary, false);

  if (result?.displayed) {
    scrollDisplayIntoView();
    const ctx = getDividerContext();
    if (ctx?.length) appendDivider(ctx.join(' \u00b7 '));
  }
  return result;
}

// Render a question card and wait for the person to answer or skip it.
// Mirrors executeTool's shape below — a helper the event switch awaits
// synchronously, so the loop only reads the next SSE event once someone has
// responded (or the card's own countdown resolves it as a skip — see
// createQuestionCard).
function askUserQuestion(questions, expiresAt) {
  return new Promise((resolve) => {
    createQuestionCard(questions, {
      expiresAt,
      onSubmit: (answers, response) => resolve({ answers, response, skipped: false }),
      onSkip: () => resolve({ skipped: true }),
    });
  });
}

// termd loop ────────────────────────────────────────────────────────────
//
// The odd one out: termd runs the agent loop on the operator's machine, so
// there is no history to carry and no tool_result to inject. We send the
// prompt with the page's tool definitions, then answer the calls that come
// back. executeTool is reused unchanged, which is the point — the trust gate
// and the tool cards behave the same whether the loop runs here or there.

async function runConversationTermd(messages, { signal, getSystemPrompt, getDividerContext, onComplete, settingSources }) {
  const last = [...messages].reverse().find(m => m.role === 'user');
  const prompt = typeof last?.content === 'string' ? last.content : '';
  let body;
  try {
    body = await streamTermdAgent({
      model: getSelectedModelName(),
      prompt: `${getSystemPrompt()}\n\n---\n\n${prompt}`,
      // `schema` is the field on a tool def; `parameters` is the OpenAI wire
      // name and does not exist here. A tool with no arguments still needs an
      // object schema, so fall back rather than send undefined.
      tools: listTools().map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema || { type: 'object', properties: {} },
      })),
      signal,
      settingSources,
    });
  } catch (err) {
    hideSpinner();
    if (err.name === 'AbortError') return;
    appendMessage('error', err.message);
    return;
  }

  let textEl = null, text = '';
  // The stream's first event; captured so a permission_request can build its
  // own resolveToken on older termd builds that don't send one yet (see
  // below).
  let turnId = null;
  try {
    for await (const evt of parseTermdStream(body)) {
      if (evt.type === 'turn') {
        turnId = evt.turnId;
      } else if (evt.type === 'text') {
        if (!textEl) { hideSpinner(); textEl = appendMessage('assistant', ''); }
        text += evt.text;
        textEl.innerHTML = renderMarkdown(text);
      } else if (evt.type === 'tool_request') {
        hideSpinner();
        const pendingEl = createPendingToolCard(evt.name);
        const result = await executeTool(evt.name, evt.input || {}, pendingEl, getDividerContext);
        // A 404 means the call already settled (timed out, or the turn ended).
        // Nothing to retry against, so surface it rather than looping.
        const landed = await answerTermdTool(evt.token, result?.error ? { error: result.error } : { content: result });
        if (!landed) appendMessage('error', `termd stopped waiting for ${evt.name}.`);
        showSpinner();
      } else if (evt.type === 'permission_request') {
        // termd parks the turn — and denies-and-interrupts it once
        // evt.expiresAt passes with no answer — whenever the embedded agent
        // calls a tool that needs a human in the loop. AskUserQuestion is
        // the only one this runtime renders a UI for; every other tool name
        // gets an automatic deny rather than generic permission UI.
        hideSpinner();
        // evt.resolveToken/expiresAt are the new termd fields; reconstruct
        // the token for older builds from the turn this request belongs to.
        const token = evt.resolveToken || `${turnId}.${evt.requestId}`;
        if (evt.name === 'AskUserQuestion') {
          const { answers, response, skipped } = await askUserQuestion(evt.input?.questions || [], evt.expiresAt);
          if (skipped) await answerTermdPermission(token, 'deny');
          else await answerTermdPermission(token, 'allow', {
            questions: evt.input.questions,
            answers,
            // Only present when at least one question was answered via
            // "Other…" — matches the SDK's AskUserQuestionOutput contract,
            // where `response` is the freeform text typed instead of a pick.
            ...(response !== undefined ? { response } : {}),
          });
        } else {
          appendMessage('error', `${evt.name} asked for permission — not supported in embedded chat; denied`);
          await answerTermdPermission(token, 'deny');
        }
        showSpinner();
      } else if (evt.type === 'result' && evt.isError) {
        appendMessage('error', evt.text || 'termd turn failed.');
      } else if (evt.type === 'error') {
        appendMessage('error', evt.error || 'termd error.');
      } else if (evt.type === 'done') {
        break;
      }
    }
  } catch (err) {
    hideSpinner();
    if (err.name !== 'AbortError') appendMessage('error', 'Stream interrupted: ' + err.message);
    return;
  }
  hideSpinner();
  onComplete?.();
}

export const runConversation = runConversationTermd;
