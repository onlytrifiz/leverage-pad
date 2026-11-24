"use client";

import { ethers } from "ethers";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { LAUNCH_ROUTER, DOPPLER, USDG, V4_POOL_MANAGER, UNIVERSAL_ROUTER, PERMIT2 } from "@/lib/clientConfig";
import { MAX_BUY_ORDERS, type BuyOrder } from "@/lib/doppler";

/** one line of the list, as typed */
export type BuyRow = { id: number; wallet: string; amount: string };

const clampUsdg = (v: string) => {
  const [i, d] = v.replace(/[^0-9.]/g, "").split(".");
  return d === undefined ? i : `${i}.${d.slice(0, 6)}`;
};

/** contracts that would swallow the tokens */
const NO_RECEIVE = new Set(
  [ethers.constants.AddressZero, LAUNCH_ROUTER, USDG, V4_POOL_MANAGER, UNIVERSAL_ROUTER, PERMIT2, ...Object.values(DOPPLER)].map((x) =>
    String(x).toLowerCase()
  )
);

const rawAmount = (v: string) => {
  try {
    return v ? ethers.utils.parseUnits(v, 6) : ethers.constants.Zero;
  } catch {
    return ethers.constants.Zero;
  }
};

/** Why a row cannot be launched with, or null. Blank rows are ignored, not errors. */
function rowError(row: BuyRow, rows: BuyRow[], launcher: string | null | undefined): string | null {
  const w = row.wallet.trim();
  if (!w && !row.amount) return null;
  if (!ethers.utils.isAddress(w)) return "Not an address";
  const a = w.toLowerCase();
  if (NO_RECEIVE.has(a)) return "This address cannot receive";
  if (launcher && a === launcher.toLowerCase()) return "Your own buy goes in the field above";
  if (rows.some((r) => r.id < row.id && r.wallet.trim().toLowerCase() === a)) return "Listed twice";
  if (rawAmount(row.amount).lte(0)) return "Add an amount";
  return null;
}

/** The list as the router takes it, or null while a row still needs fixing. */
export function toOrders(rows: BuyRow[], launcher: string | null | undefined): BuyOrder[] | null {
  const filled = rows.filter((r) => r.wallet.trim() || r.amount);
  if (filled.some((r) => rowError(r, rows, launcher))) return null;
  return filled.map((r) => ({ wallet: ethers.utils.getAddress(r.wallet.trim().toLowerCase()), amount: rawAmount(r.amount) }));
}

/** "0x… 10" per line, comma, space, tab or colon in between; the amount may be missing */
function parsePaste(text: string): { wallet: string; amount: string }[] {
  return text
    .split(/\n+/)
    .map((l) => l.trim().split(/[\s,;:]+/))
    .filter((p) => p[0])
    .map(([wallet, amount]) => ({ wallet, amount: clampUsdg(amount ?? "") }));
}

let nextId = 1;
const blank = (): BuyRow => ({ id: nextId++, wallet: "", amount: "" });

/**
 * Other wallets in the launch buy. The launcher pays for all of them in the launch itself; each
 * wallet only receives. Paste a list into any address field to fill several lines at once.
 */
export default function BuyWallets({
  rows,
  onChange,
  launcher,
}: {
  rows: BuyRow[];
  onChange: (rows: BuyRow[]) => void;
  launcher: string | null | undefined;
}) {
  const set = (id: number, patch: Partial<BuyRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const full = rows.length >= MAX_BUY_ORDERS;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink">Buy for other wallets, optional</span>
        {rows.length > 0 && (
          <span className="num text-xs text-ink-3">
            {rows.length} of {MAX_BUY_ORDERS}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        You pay, they receive, in the same first swap and at the same price. The list is public in the launch transaction.
      </p>

      {rows.length > 0 && (
        <ul className="mt-3 space-y-2">
          {rows.map((r, i) => {
            const err = rowError(r, rows, launcher);
            // silent while a field is still empty: it is being typed, the button says the rest
            const shown = err && r.wallet.trim() && (r.amount || err !== "Add an amount") ? err : null;
            return (
              <li key={r.id}>
                <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                  <Input
                    value={r.wallet}
                    onChange={(e) => set(r.id, { wallet: e.target.value.trim().slice(0, 42) })}
                    onPaste={(e) => {
                      const items = parsePaste(e.clipboardData.getData("text"));
                      if (items.length < 2 && !items[0]?.amount) return;
                      e.preventDefault();
                      const at = rows.findIndex((x) => x.id === r.id);
                      const pasted = items.map((x) => ({ ...blank(), wallet: x.wallet.slice(0, 42), amount: x.amount || r.amount }));
                      onChange([...rows.slice(0, at), ...pasted, ...rows.slice(at + 1)].slice(0, MAX_BUY_ORDERS));
                    }}
                    placeholder="0x…"
                    aria-label={`Wallet ${i + 1}`}
                    aria-invalid={!!shown || undefined}
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="num h-10 w-full min-w-0 sm:w-auto sm:flex-1"
                  />
                  <Input
                    value={r.amount}
                    onChange={(e) => set(r.id, { amount: clampUsdg(e.target.value) })}
                    placeholder="USDG"
                    inputMode="decimal"
                    aria-label={`USDG for wallet ${i + 1}`}
                    className="num h-10 min-w-0 flex-1 sm:w-28 sm:flex-none"
                  />
                  <button
                    type="button"
                    onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
                    aria-label={`Remove wallet ${i + 1}`}
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
                  >
                    <X size={15} aria-hidden />
                  </button>
                </div>
                {shown && (
                  <p className="mt-1 text-xs text-down" role="alert">
                    {shown}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          disabled={full}
          onClick={() => onChange([...rows, { ...blank(), amount: rows[rows.length - 1]?.amount ?? "" }])}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line px-3.5 text-xs font-medium text-ink-2 transition-colors hover:border-line-2 disabled:opacity-40"
        >
          <Plus size={13} aria-hidden />
          {full ? `${MAX_BUY_ORDERS} wallets is the most` : "Add a wallet"}
        </button>
        {rows.length > 0 && !full && <span className="text-xs text-ink-3">Or paste a list, one “address amount” per line.</span>}
      </div>
    </div>
  );
}
