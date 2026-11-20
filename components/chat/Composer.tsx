"use client";

import { useState } from "react";

export function Composer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (message: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || disabled) return;
    onSend(message);
    setInput("");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex gap-2 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800 sm:px-8"
    >
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={placeholder ?? "Type your message…"}
        disabled={disabled}
        maxLength={4000}
        className="flex-1 rounded-full border border-zinc-300 bg-transparent px-4 py-2 text-sm outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700"
      />
      <button
        type="submit"
        disabled={disabled || input.trim().length === 0}
        className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Send
      </button>
    </form>
  );
}
