import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
        Loopp Support Agent
      </h1>
      <p className="mt-4 max-w-xl text-center text-lg text-zinc-600 dark:text-zinc-400">
        A Customer Support AI Agent with streaming chat, live voice, RAG,
        tool orchestration, and built-in observability. Built for the Loopp
        AI Engineer technical assessment.
      </p>
      <Link
        href="/chat"
        className="mt-8 rounded-full bg-zinc-900 px-6 py-3 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Open the chat →
      </Link>
    </main>
  );
}
