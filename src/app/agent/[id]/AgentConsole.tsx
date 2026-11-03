"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useState } from "react";

export function AgentConsole({ agentId, name }: { agentId: string; name: string }) {
  const initial: UIMessage[] = [
    {
      id: "n0",
      role: "assistant",
      parts: [{ type: "text", text: `Hi, I'm ${name} — give me a shopping mission and I'll negotiate it.` }],
    },
  ];

  const { messages, sendMessage, status } = useChat({ transport: new DefaultChatTransport({ api: `/api/agents/${agentId}/chat` }), messages: initial });
  const [input, setInput] = useState("");
  const [wallet, setWallet] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/agents/${agentId}/wallet`)
      .then((r) => r.json())
      .then((d) => setWallet(d.balance_cents))
      .catch(() => {});
  }, [agentId, messages.length]);

  return (
    <div className="mx-auto flex h-[80vh] max-w-3xl flex-col gap-4 px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{name}</h1>
        <span className="text-sm text-gray-500">
          wallet: ${wallet === null ? "…" : (wallet / 100).toFixed(2)}
        </span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto rounded-xl border p-4">
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === "user" ? "bg-blue-600 text-white" : "bg-gray-100"
              }`}
            >
              {m.parts
                .filter((p) => p.type === "text")
                .map((p, i) => (
                  <span key={i}>{p.text}</span>
                ))}
            </div>
          </div>
        ))}
        {(status === "submitted" || status === "streaming") && (
          <p className="animate-pulse text-xs text-gray-400">thinking…</p>
        )}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!input.trim()) return;
          sendMessage({ text: input });
          setInput("");
        }}
      >
        <input
          className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. find me a used espresso grinder under $120"
        />
        <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white" type="submit">
          Send
        </button>
      </form>
    </div>
  );
}
