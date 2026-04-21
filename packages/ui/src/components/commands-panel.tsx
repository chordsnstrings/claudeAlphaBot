"use client";

import { useState } from "react";

import { Card } from "./card";
import { cn } from "@/lib/cn";

type Status = "idle" | "pending" | "ok" | "error";

interface CommandState {
  readonly status: Status;
  readonly message: string;
}

const initial: CommandState = { status: "idle", message: "" };

/**
 * Five buttons that POST to /api/commands/*. Destructive buttons
 * (close-all, force-revalidate) confirm before firing. Every button is
 * rate-limited at 1 req / 10s server-side; the UI just surfaces whatever
 * the bot returns.
 */
export function CommandsPanel({ artifactHash }: { readonly artifactHash: string | null }) {
  const [states, setStates] = useState<Record<string, CommandState>>({});

  async function run(cmd: string, body: unknown = null, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setStates((s) => ({ ...s, [cmd]: { status: "pending", message: "running…" } }));
    try {
      const reqInit: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
      };
      if (body !== null) reqInit.body = JSON.stringify(body);
      const res = await fetch(`/api/commands/${cmd}`, reqInit);
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        ok?: boolean;
        mode?: string;
        closed?: number;
      };
      if (res.ok) {
        setStates((s) => ({
          ...s,
          [cmd]: { status: "ok", message: summarise(cmd, json) },
        }));
      } else {
        setStates((s) => ({
          ...s,
          [cmd]: {
            status: "error",
            message:
              res.status === 429
                ? "Rate-limited (wait 10s)"
                : `${res.status}: ${json.error ?? "failed"}`,
          },
        }));
      }
    } catch (err) {
      setStates((s) => ({
        ...s,
        [cmd]: {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Button
        label="Pause Trading"
        description="Switch bot to backtest-only mode. Safe to invoke."
        state={states["pause"] ?? initial}
        onClick={() => run("pause")}
      />
      <Button
        label="Resume Trading"
        description="Restore the previous live / paper mode."
        state={states["resume"] ?? initial}
        onClick={() => run("resume")}
      />
      <Button
        label="Force Revalidation"
        description="Triggers a fortnightly revalidation immediately."
        variant="caution"
        state={states["force-revalidate"] ?? initial}
        onClick={() =>
          run("force-revalidate", null, "Kick off a full revalidation run now?")
        }
      />
      <Button
        label="Close All Positions"
        description="Market-closes every open position. DESTRUCTIVE."
        variant="danger"
        state={states["close-all-positions"] ?? initial}
        onClick={() =>
          run(
            "close-all-positions",
            { confirm: "CONFIRM_CLOSE_ALL" },
            "Market-close every open position right now? This cannot be undone.",
          )
        }
      />
      <Button
        label={
          artifactHash
            ? `Approve Artifact ${artifactHash.slice(0, 10)}…`
            : "Approve Artifact (none staged)"
        }
        description="Approve the pending revalidation artifact for live use."
        disabled={!artifactHash}
        state={states["approve-artifact"] ?? initial}
        onClick={() =>
          run(
            "approve-artifact",
            { artifactHash },
            `Approve artifact ${artifactHash?.slice(0, 12)}… for deployment?`,
          )
        }
      />
    </div>
  );
}

function summarise(cmd: string, json: { mode?: string; closed?: number }): string {
  if (cmd === "pause" || cmd === "resume") return `mode → ${json.mode ?? "unknown"}`;
  if (cmd === "close-all-positions") return `closed ${json.closed ?? 0} positions`;
  return "ok";
}

function Button({
  label,
  description,
  state,
  onClick,
  variant = "default",
  disabled = false,
}: {
  readonly label: string;
  readonly description: string;
  readonly state: CommandState;
  readonly onClick: () => void;
  readonly variant?: "default" | "caution" | "danger";
  readonly disabled?: boolean;
}) {
  const btnClass =
    variant === "danger"
      ? "bg-red text-white hover:bg-red/90"
      : variant === "caution"
        ? "bg-orange text-bg-0 hover:bg-orange/90"
        : "bg-accent text-bg-0 hover:bg-accent-hover";
  const statusColor =
    state.status === "ok"
      ? "text-green"
      : state.status === "error"
        ? "text-red"
        : state.status === "pending"
          ? "text-accent"
          : "text-text-tertiary";

  return (
    <Card padding="md" className="animate-fade-up">
      <div className="flex items-start justify-between gap-3 mb-2 px-1">
        <div>
          <div className="text-subhead font-medium text-text-primary">{label}</div>
          <p className="text-default text-text-tertiary mt-1">{description}</p>
        </div>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled || state.status === "pending"}
          className={cn(
            "rounded-md px-3 py-1.5 font-medium transition-colors duration-150 whitespace-nowrap",
            "disabled:opacity-40 disabled:cursor-not-allowed",
            "focus:outline-none focus:ring-2 focus:ring-accent",
            btnClass,
          )}
        >
          {state.status === "pending" ? "…" : "Run"}
        </button>
      </div>
      <div className={cn("text-secondary font-mono pl-1 min-h-[1em]", statusColor)}>
        {state.message}
      </div>
    </Card>
  );
}
