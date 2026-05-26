/**
 * Minimal OpenAI-compatible SSE chat-completions streamer.
 *
 * The ai.hsingh.app endpoint is OpenAI-compatible: POST /v1/chat/completions
 * with { model, messages, stream: true } returns text/event-stream where
 * each `data:` line is a JSON delta `{ choices: [{ delta: { content }}]}`,
 * terminated by `data: [DONE]`.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatStreamOptions {
  endpoint?: string;
  model?: string;
  apiKey?: string;
  signal?: AbortSignal;
  messages: ChatMessage[];
  onChunk: (delta: string) => void;
  onDone: (full: string) => void;
  onError: (err: Error) => void;
}

const DEFAULT_ENDPOINT = "https://ai.hsingh.app/v1/chat/completions";

export async function streamChat(opts: ChatStreamOptions): Promise<void> {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? "auto";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: opts.messages,
        stream: true,
      }),
      signal: opts.signal,
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffered = "";
    let fullText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // SSE separates events by blank line; within an event, lines starting
      // with `data:` are the payload.
      let idx: number;
      while ((idx = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, idx).replace(/\r$/, "");
        buffered = buffered.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trimStart();
        if (payload === "[DONE]") {
          opts.onDone(fullText);
          return;
        }
        try {
          const obj = JSON.parse(payload);
          const delta = obj?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            fullText += delta;
            opts.onChunk(delta);
          }
        } catch {
          // ignore non-JSON keep-alives
        }
      }
    }
    opts.onDone(fullText);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      opts.onDone("");
      return;
    }
    opts.onError(err as Error);
  }
}
