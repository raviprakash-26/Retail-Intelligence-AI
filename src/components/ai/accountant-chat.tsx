"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChevronDown,
  Info,
  Loader2,
  Send,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import { askAccountantAction } from "@/server/ai/actions";
import type { StoredMessage } from "@/server/ai/accountant";

/**
 * The AI Accountant.
 *
 * Two things on this page exist to keep it honest rather than to make it look
 * clever.
 *
 * **Every answer shows what it asked for.** The tool calls behind a reply are
 * one click away, with the arguments they were given, so a figure can be traced
 * to the query that produced it. An answer with nothing behind it is visibly an
 * answer with nothing behind it.
 *
 * **An answer that quotes money without asking for any is marked.** That check
 * is deterministic and runs before anybody reads the reply — it does not depend
 * on the model admitting anything.
 */
export function AccountantChat({
  conversationId,
  messages,
  suggestions,
  available,
  unavailableReason,
}: {
  conversationId: string | null;
  messages: StoredMessage[];
  suggestions: string[];
  available: boolean;
  unavailableReason: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending]);

  async function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setPending(true);
    setError(null);

    const form = new FormData();
    form.set("question", trimmed);
    if (conversationId) form.set("conversationId", conversationId);

    const result = await askAccountantAction(null, form);
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setDraft("");
    router.push(
      `/app/ai/accountant?conversation=${result.data.conversationId}` as Route,
    );
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {!available && (
        <div className="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4" />
            The assistant is not switched on
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            {unavailableReason} Nothing has been substituted in the meantime —
            an assistant that invented plausible answers when its provider was
            missing would be worse than one that is honestly off. Every figure
            it would quote is on the pages themselves.
          </p>
        </div>
      )}

      <div className="rounded-xl border">
        <div className="border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">What it can and cannot do</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            It reads your books through the same reports you can open yourself,
            and every figure it quotes comes from one of them — it does no
            arithmetic of its own. It cannot post, edit or void anything, it can
            only see this business, and it is not a chartered accountant or a
            tax adviser.
          </p>
        </div>

        <div className="max-h-[32rem] space-y-4 overflow-y-auto px-5 py-5">
          {messages.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">
                Ask about anything in your books.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={!available || pending}
                    onClick={() => void submit(suggestion)}
                    className="rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))
          )}

          {pending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Reading your books…
            </p>
          )}
          <div ref={endRef} />
        </div>

        <form
          className="border-t px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(draft);
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              name="question"
              value={draft}
              disabled={!available || pending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit(draft);
                }
              }}
              placeholder={
                available
                  ? "How much did I make last month?"
                  : "The assistant is not switched on."
              }
              rows={2}
              className="min-h-[3rem] resize-none"
            />
            <Button
              type="submit"
              disabled={!available || pending || draft.trim().length === 0}
            >
              <Send className="size-4" />
              Ask
            </Button>
          </div>
          {error && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </form>
      </div>

      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Every question and answer is kept, with the queries behind it, so a
          figure quoted here can be traced months later. Anything about GST or
          income tax is prepared for review — nothing in this product has been
          filed with anybody.
        </span>
      </p>
    </div>
  );
}

function MessageBubble({ message }: { message: StoredMessage }) {
  const [open, setOpen] = React.useState(false);

  if (message.role === "USER") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-xl bg-secondary px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {message.errorMessage ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3">
          <p className="text-sm text-destructive">{message.errorMessage}</p>
        </div>
      ) : (
        <p className="max-w-[92%] text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
        </p>
      )}

      {message.unverified && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            This answer states an amount without having looked anything up, so
            the figure could not be traced to a query. Check it against the
            report it should have come from before relying on it.
          </span>
        </p>
      )}

      {message.toolCalls.length > 0 && (
        <div className="rounded-lg border">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-secondary/50"
            aria-expanded={open}
          >
            <Wrench className="size-3.5" />
            <span>
              {message.toolCalls.length}{" "}
              {message.toolCalls.length === 1 ? "query" : "queries"} behind this
              answer
            </span>
            <ChevronDown
              className={`ml-auto size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
          {open && (
            <ul className="space-y-1.5 border-t px-3 py-2.5">
              {message.toolCalls.map((call, index) => (
                <li
                  key={`${call.name}-${index}`}
                  className="flex flex-wrap items-baseline gap-2 text-xs"
                >
                  <Badge variant={call.ok ? "muted" : "warning"}>
                    {call.name}
                  </Badge>
                  <span className="font-mono text-muted-foreground">
                    {describeArguments(call.input)}
                  </span>
                  {!call.ok && (
                    <span className="text-warning-foreground">
                      {call.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        {formatDateTime(message.createdAt)}
      </p>
    </div>
  );
}

/** The arguments a query was given, short enough to sit on one line. */
function describeArguments(input: unknown): string {
  if (!input || typeof input !== "object") return "no arguments";
  const entries = Object.entries(input as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== "",
  );
  if (entries.length === 0) return "no arguments";
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(", ");
}
