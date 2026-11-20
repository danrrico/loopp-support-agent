import { NextResponse } from "next/server";

// TODO (build phase): mint an ephemeral OpenAI Realtime session key here
// (POST https://api.openai.com/v1/realtime/sessions with OPENAI_API_KEY) and
// return it so the browser can open a WebRTC session. Until then, this
// endpoint reports that voice is not configured.
export async function POST() {
  return NextResponse.json(
    { error: "not configured — OPENAI_API_KEY required" },
    { status: 503 },
  );
}
