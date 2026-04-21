import { NextResponse } from "next/server";

import { callBot } from "@/lib/bot-api";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const res = await callBot("/api/commands/close-all-positions", {
    method: "POST",
    body,
    requester: req.headers.get("x-requester") ?? "ui",
  });
  return NextResponse.json(res.body, { status: res.status || 502 });
}
