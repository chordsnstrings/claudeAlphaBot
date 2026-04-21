import { NextResponse } from "next/server";

import { callBot } from "@/lib/bot-api";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const res = await callBot("/api/commands/force-revalidate", {
    method: "POST",
    requester: req.headers.get("x-requester") ?? "ui",
  });
  return NextResponse.json(res.body, { status: res.status || 502 });
}
