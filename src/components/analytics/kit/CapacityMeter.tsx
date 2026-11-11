import { RiAlertLine, RiCheckLine, RiErrorWarningLine } from "@remixicon/react";
import { cn } from "@/utils/cn";
import { ACCENT, STATUS } from "../theme";

/**
 * Segmented meter for used / limit (daily send caps, warm-up limits). The fill
 * shifts accent -> warning at 80% -> critical at 100%; the state is also
 * written out with an icon ("Near limit", "At limit"), never colour alone. The
 * unfilled track is a lighter tint of the same colour so the state reads
 * across the whole bar.
 *
 * Props: `label`, `used`, `limit`, `segments` (default 20), `detail` (small
 * text under the label, e.g. an email address).
 */
const TONES = {
  ok: { fill: ACCENT, track: "bg-[#dbe8fa] dark:bg-[#335cff]/25" },
  warning: { fill: STATUS.warning, track: "bg-[#feefc9] dark:bg-[#e5930a]/25" },
  critical: { fill: STATUS.critical, track: "bg-[#f5d5d5] dark:bg-[#fb3748]/25" },
} as const;

export function CapacityMeter({ label, used, limit, segments = 20, detail }: { label: string; used: number; limit: number; segments?: number; detail?: string }) {
  const fraction = limit > 0 ? used / limit : 0;
  const state = fraction >= 1 ? "critical" : fraction >= 0.8 ? "warning" : "ok";
  const tone = TONES[state];
  const filled = used <= 0 ? 0 : Math.min(segments, Math.max(1, Math.round(fraction * segments)));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-label-sm text-text-strong-950">{label}</p>
          {detail && <p className="truncate text-paragraph-xs text-text-soft-400">{detail}</p>}
        </div>
        <p className="shrink-0 text-label-sm text-text-strong-950">
          {used.toLocaleString("en-US")} <span className="text-text-soft-400">/ {limit.toLocaleString("en-US")}</span>
        </p>
      </div>
      <div role="meter" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} className="mt-2 flex h-2 gap-0.5">
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={cn("h-full flex-1 rounded-[2px]", i >= filled && tone.track)} style={i < filled ? { backgroundColor: tone.fill } : undefined} />
        ))}
      </div>
      <p className={cn("mt-1.5 flex items-center gap-1 text-paragraph-xs", state === "ok" ? "text-text-soft-400" : "text-text-sub-600")}>
        {state === "ok" && <RiCheckLine className="size-3.5" aria-hidden="true" />}
        {state === "warning" && <RiAlertLine className="size-3.5" aria-hidden="true" style={{ color: tone.fill }} />}
        {state === "critical" && <RiErrorWarningLine className="size-3.5" aria-hidden="true" style={{ color: tone.fill }} />}
        {state === "ok" ? "Within limit" : state === "warning" ? "Near limit" : fraction > 1 ? "Over limit" : "At limit"}
      </p>
    </div>
  );
}
