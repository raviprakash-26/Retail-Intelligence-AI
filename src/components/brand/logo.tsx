import * as React from "react";
import { cn } from "@/lib/utils";
import { publicEnv } from "@/lib/env";

/**
 * The RIAI mark.
 *
 * Three ideas in one glyph:
 *   • the stepped bars read as a ledger's ruled lines and as a growth chart,
 *   • the ascending line ties them into a single trend,
 *   • the node at the apex is the "intelligence" — the point where the data
 *     turns into an answer.
 *
 * Drawn on a 32×32 grid with 2px strokes so it stays legible at favicon size.
 */

type LogoMarkProps = React.ComponentProps<"svg"> & {
  /** Fills the rounded plate with the brand gradient. */
  filled?: boolean;
};

export function LogoMark({
  className,
  filled = true,
  ...props
}: LogoMarkProps) {
  const gradientId = React.useId();

  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      className={cn("size-8", className)}
      {...props}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--primary)" />
          <stop offset="1" stopColor="var(--ai)" />
        </linearGradient>
      </defs>

      {filled ? (
        <rect width="32" height="32" rx="8.5" fill={`url(#${gradientId})`} />
      ) : (
        <rect
          x="0.9"
          y="0.9"
          width="30.2"
          height="30.2"
          rx="8"
          stroke="currentColor"
          strokeWidth="1.8"
          opacity="0.35"
        />
      )}

      {/* Ledger bars, ascending left to right. */}
      <g
        stroke={filled ? "var(--primary-foreground)" : "currentColor"}
        strokeWidth="2.4"
        strokeLinecap="round"
      >
        <path d="M9.5 22.5v-4" opacity="0.55" />
        <path d="M16 22.5v-7.5" opacity="0.75" />
        <path d="M22.5 22.5v-11" opacity="0.95" />
      </g>

      {/* Trend line through the bar tops. */}
      <path
        d="M9.5 18.5 16 15l6.5-3.5"
        stroke={filled ? "var(--primary-foreground)" : "currentColor"}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.5"
      />

      {/* The insight node. */}
      <circle
        cx="22.5"
        cy="11.5"
        r="3"
        fill={filled ? "var(--primary-foreground)" : "currentColor"}
      />
      <circle
        cx="22.5"
        cy="11.5"
        r="1.35"
        fill={filled ? "var(--ai)" : "var(--background)"}
      />
    </svg>
  );
}

type LogoProps = React.ComponentProps<"div"> & {
  /** `full` shows the wordmark, `compact` shows only the abbreviation. */
  variant?: "full" | "compact" | "mark";
  size?: "sm" | "md" | "lg";
  showTagline?: boolean;
};

const SIZES = {
  sm: { mark: "size-7", name: "text-sm", tagline: "text-[0.625rem]" },
  md: { mark: "size-8", name: "text-base", tagline: "text-[0.6875rem]" },
  lg: { mark: "size-11", name: "text-xl", tagline: "text-xs" },
} as const;

export function Logo({
  variant = "full",
  size = "md",
  showTagline = false,
  className,
  ...props
}: LogoProps) {
  const scale = SIZES[size];

  return (
    <div className={cn("flex items-center gap-2.5", className)} {...props}>
      <LogoMark className={scale.mark} />

      {variant !== "mark" && (
        <div className="flex flex-col leading-none">
          <span
            className={cn(
              "font-semibold tracking-tight whitespace-nowrap",
              scale.name,
            )}
          >
            {variant === "compact" ? (
              publicEnv.appShortName
            ) : (
              <>
                Retail <span className="text-primary">Intelligence</span>{" "}
                <span className="font-medium text-muted-foreground">AI</span>
              </>
            )}
          </span>
          {showTagline && (
            <span className={cn("mt-1 text-muted-foreground", scale.tagline)}>
              Smart Accounting. Intelligent Auditing.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
