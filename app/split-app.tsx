"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CircleDollarSign, Download, Pencil, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type Friend = { id: string; name: string };
type SplitMethod = "equal" | "shares" | "percentage" | "exact";
type SplitLine = { friendId: string; friendName: string; amount: number };
type Expense = { id: string; name: string; description: string; price: number; currency: string; date: string; payerId: string; payerName: string; method: SplitMethod; splits: SplitLine[]; splitInputs?: Record<string, number> };
type Group = { id: string; name: string; friends: Friend[]; expenses: Expense[]; primaryCurrency?: string; exchangeRates?: Record<string, string>; settleInPrimary?: boolean };
type AppData = { version: 1; groups: Group[]; activeGroupId: string };
type Draft = { name: string; description: string; price: string; currency: string; otherCurrency: string; date: string; payerId: string; method: SplitMethod; selected: string[]; values: Record<string, string> };
type Balance = { id: string; name: string; amount: number; removed: boolean };
type Settlement = { from: string; to: string; amount: number };

const currencies = ["SGD", "MYR", "USD", "EUR", "GBP", "JPY", "TWD", "AUD", "Other"];
const symbols: Record<string, string> = { SGD: "S$", MYR: "RM", USD: "$", EUR: "€", GBP: "£", JPY: "¥", TWD: "NT$", AUD: "A$" };
const methods: { key: SplitMethod; label: string }[] = [
  { key: "equal", label: "Equally" }, { key: "shares", label: "Shares" },
  { key: "percentage", label: "Percentage" }, { key: "exact", label: "Exact amount" },
];
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100);
const blankDraft = (): Draft => ({ name: "", description: "", price: "", currency: "SGD", otherCurrency: "", date: today(), payerId: "", method: "equal", selected: [], values: {} });
const draftFromExpense = (expense: Expense): Draft => {
  const isKnownCurrency = currencies.includes(expense.currency) && expense.currency !== "Other";
  let values: Record<string, string> = {};
  if (expense.method !== "equal") {
    if (expense.splitInputs) {
      values = Object.fromEntries(Object.entries(expense.splitInputs).map(([id, value]) => [id, String(value)]));
    } else if (expense.method === "percentage") {
      let used = 0;
      expense.splits.forEach((line, index) => {
        const value = index === expense.splits.length - 1 ? 100 - used : Number(((line.amount / expense.price) * 100).toFixed(6));
        values[line.friendId] = String(value);
        used += value;
      });
    } else {
      values = Object.fromEntries(expense.splits.map((line) => [line.friendId, String(expense.method === "exact" ? line.amount / 100 : line.amount)]));
    }
  }
  return { name: expense.name, description: expense.description, price: String(expense.price / 100), currency: isKnownCurrency ? expense.currency : "Other", otherCurrency: isKnownCurrency ? "" : expense.currency, date: expense.date, payerId: expense.payerId, method: expense.method, selected: expense.splits.map((line) => line.friendId), values };
};
const newGroup = (name: string): Group => ({ id: uid(), name, friends: [], expenses: [], primaryCurrency: "SGD", exchangeRates: {}, settleInPrimary: false });
const initialData = (): AppData => { const first = newGroup("Weekend trip"), second = newGroup("Household"); return { version: 1, activeGroupId: first.id, groups: [first, second] }; };
const money = (amount: number, currency: string) => `${symbols[currency] ?? `${currency} `}${(amount / 100).toLocaleString(undefined, { minimumFractionDigits: currency === "JPY" ? 0 : 2, maximumFractionDigits: currency === "JPY" ? 0 : 2 })}`;

function calculateSplits(draft: Draft, friends: Friend[]) {
  const total = cents(Number(draft.price));
  const selected = draft.selected.map((id) => friends.find((f) => f.id === id)).filter(Boolean) as Friend[];
  if (!selected.length || total <= 0) return { valid: false, lines: [] as SplitLine[], status: "Select at least one participant" };
  let raw: number[] = [], status = "";
  if (draft.method === "equal") {
    const base = Math.floor(total / selected.length), remainder = total - base * selected.length;
    raw = selected.map((_, i) => base + (i < remainder ? 1 : 0));
    status = `${money(total, draft.currency === "Other" ? draft.otherCurrency : draft.currency)} across ${selected.length}`;
  } else if (draft.method === "shares") {
    const values = selected.map((f) => Math.max(0, Number(draft.values[f.id] || 0)));
    const sum = values.reduce((a, b) => a + b, 0);
    if (!sum) return { valid: false, lines: [] as SplitLine[], status: "Enter at least one share" };
    raw = values.map((v) => Math.floor(total * v / sum)); raw[raw.length - 1] += total - raw.reduce((a, b) => a + b, 0);
    status = `${sum} total share${sum === 1 ? "" : "s"}`;
  } else if (draft.method === "percentage") {
    const values = selected.map((f) => Number(draft.values[f.id] || 0));
    const sum = values.reduce((a, b) => a + b, 0);
    raw = values.map((v) => Math.round(total * v / 100));
    status = `${sum.toFixed(sum % 1 ? 1 : 0)}% of 100%`;
    if (Math.abs(sum - 100) >= 0.005) return { valid: false, lines: [] as SplitLine[], status };
    raw[raw.length - 1] += total - raw.reduce((a, b) => a + b, 0);
  } else {
    raw = selected.map((f) => cents(Number(draft.values[f.id] || 0)));
    const sum = raw.reduce((a, b) => a + b, 0);
    const code = draft.currency === "Other" ? draft.otherCurrency : draft.currency;
    status = `${money(sum, code)} of ${money(total, code)}`;
    if (Math.abs(sum - total) > 1) return { valid: false, lines: [] as SplitLine[], status };
    raw[raw.length - 1] += total - sum;
  }
  return { valid: raw.every((v) => v >= 0), lines: selected.map((f, i) => ({ friendId: f.id, friendName: f.name, amount: raw[i] })), status };
}

function getBalances(group: Group, currency: string): Balance[] {
  const names = new Map<string, string>();
  group.friends.forEach((f) => names.set(f.id, f.name));
  group.expenses.filter((e) => e.currency === currency).forEach((e) => { names.set(e.payerId, e.payerName); e.splits.forEach((s) => names.set(s.friendId, s.friendName)); });
  const amounts = new Map([...names.keys()].map((id) => [id, 0]));
  group.expenses.filter((e) => e.currency === currency).forEach((e) => {
    amounts.set(e.payerId, (amounts.get(e.payerId) || 0) + e.price);
    e.splits.forEach((s) => amounts.set(s.friendId, (amounts.get(s.friendId) || 0) - s.amount));
  });
  return [...names].map(([id, name]) => ({ id, name, amount: amounts.get(id) || 0, removed: !group.friends.some((f) => f.id === id) }));
}

function getConvertedBalances(group: Group, primaryCurrency: string, rates: Record<string, string>): Balance[] {
  const names = new Map<string, string>();
  group.friends.forEach((friend) => names.set(friend.id, friend.name));
  group.expenses.forEach((expense) => {
    names.set(expense.payerId, expense.payerName);
    expense.splits.forEach((line) => names.set(line.friendId, line.friendName));
  });
  const amounts = new Map([...names.keys()].map((id) => [id, 0]));
  group.expenses.forEach((expense) => {
    const rate = expense.currency === primaryCurrency ? 1 : Number(rates[expense.currency]);
    if (!Number.isFinite(rate) || rate <= 0) return;
    const convertedTotal = Math.round(expense.price * rate);
    const convertedSplits = expense.splits.map((line) => Math.round(line.amount * rate));
    if (convertedSplits.length) convertedSplits[convertedSplits.length - 1] += convertedTotal - convertedSplits.reduce((sum, amount) => sum + amount, 0);
    amounts.set(expense.payerId, (amounts.get(expense.payerId) || 0) + convertedTotal);
    expense.splits.forEach((line, index) => amounts.set(line.friendId, (amounts.get(line.friendId) || 0) - convertedSplits[index]));
  });
  return [...names].map(([id, name]) => ({ id, name, amount: amounts.get(id) || 0, removed: !group.friends.some((friend) => friend.id === id) }));
}

function settle(balances: Balance[]): Settlement[] {
  const debtors = balances.filter((b) => b.amount < 0).map((b) => ({ ...b, left: -b.amount })).sort((a, b) => b.left - a.left);
  const creditors = balances.filter((b) => b.amount > 0).map((b) => ({ ...b, left: b.amount })).sort((a, b) => b.left - a.left);
  const result: Settlement[] = []; let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    result.push({ from: debtors[i].name, to: creditors[j].name, amount });
    debtors[i].left -= amount; creditors[j].left -= amount;
    if (debtors[i].left === 0) i++; if (creditors[j].left === 0) j++;
  }
  return result;
}

export default function SplitApp({ canSync }: { canSync: boolean }) {
  const [data, setData] = useState<AppData>(() => initialData());
  const [ready, setReady] = useState(false);
  const [sync, setSync] = useState<"saving" | "synced" | "local">(canSync ? "saving" : "local");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [friendName, setFriendName] = useState("");
  const [friendError, setFriendError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const group = data.groups.find((g) => g.id === data.activeGroupId) ?? data.groups[0];
  const draft = drafts[group.id] ?? blankDraft();
  const editingExpense = group.expenses.find((expense) => expense.id === editingExpenseId);
  const formFriends = editingExpense ? [...group.friends, ...[{ id: editingExpense.payerId, name: editingExpense.payerName }, ...editingExpense.splits.map((line) => ({ id: line.friendId, name: line.friendName }))].filter((candidate, index, all) => !group.friends.some((friend) => friend.id === candidate.id) && all.findIndex((friend) => friend.id === candidate.id) === index)] : group.friends;
  const currency = draft.currency === "Other" ? draft.otherCurrency.trim().toUpperCase() : draft.currency;
  const split = calculateSplits(draft, formFriends);
  const currenciesInUse = [...new Set(group.expenses.map((e) => e.currency))];
  const primaryCurrency = group.primaryCurrency ?? "SGD";
  const exchangeRates = group.exchangeRates ?? {};
  const conversionCurrencies = currenciesInUse.filter((code) => code !== primaryCurrency);
  const conversionReady = conversionCurrencies.every((code) => Number.isFinite(Number(exchangeRates[code])) && Number(exchangeRates[code]) > 0);
  const primaryCurrencyOptions = [...new Set([...currencies.filter((code) => code !== "Other"), ...currenciesInUse])];

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      const local = localStorage.getItem("split-app-data");
      if (local && !cancelled) try { setData(JSON.parse(local)); } catch {}
      if (canSync) {
        try {
          const response = await fetch("/api/state");
          if (!response.ok) throw new Error();
          const remote = await response.json();
          if (!cancelled && remote.data) setData(remote.data);
          if (!cancelled) setSync("synced");
        } catch { if (!cancelled) setSync("local"); }
      }
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [canSync]);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem("split-app-data", JSON.stringify(data));
    if (!canSync) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { setSync("saving"); void fetch("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) })
      .then((r) => { if (!r.ok) throw new Error(); setSync("synced"); }).catch(() => setSync("local"));
    }, 550);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [data, ready, canSync]);

  const updateGroup = (fn: (g: Group) => Group) => setData((old) => ({ ...old, groups: old.groups.map((g) => g.id === old.activeGroupId ? fn(g) : g) }));
  const updateDraft = (patch: Partial<Draft>) => setDrafts((old) => ({ ...old, [group.id]: { ...draft, ...patch } }));
  function addGroup() {
    const next = newGroup(`Group ${data.groups.length + 1}`);
    setData((old) => ({ ...old, groups: [...old.groups, next], activeGroupId: next.id }));
    setFriendName(""); setFriendError(""); setEditingExpenseId(null); setShowForm(false);
  }
  function removeGroup() {
    if (data.groups.length <= 1 || !window.confirm(`Delete “${group.name}” and all its expenses?`)) return;
    setData((old) => {
      const groups = old.groups.filter((item) => item.id !== old.activeGroupId);
      return { ...old, groups, activeGroupId: groups[0].id };
    });
    setFriendName(""); setFriendError(""); setEditingExpenseId(null); setShowForm(false);
  }
  function addFriend() {
    const name = friendName.trim(); if (!name) return;
    if (group.friends.some((f) => f.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { setFriendError("That name is already in this group."); return; }
    updateGroup((g) => ({ ...g, friends: [...g.friends, { id: uid(), name }] })); setFriendName(""); setFriendError("");
  }
  function removeFriend(id: string) {
    updateGroup((g) => ({ ...g, friends: g.friends.filter((f) => f.id !== id) }));
    updateDraft({ selected: draft.selected.filter((x) => x !== id), payerId: draft.payerId === id ? "" : draft.payerId });
  }
  function openAddExpense() {
    setEditingExpenseId(null);
    setShowForm(true);
  }
  function openEditExpense(expense: Expense) {
    setDrafts((old) => ({ ...old, [group.id]: draftFromExpense(expense) }));
    setEditingExpenseId(expense.id);
    setShowForm(true);
  }
  function closeExpenseForm() {
    if (editingExpenseId) setDrafts((old) => ({ ...old, [group.id]: blankDraft() }));
    setEditingExpenseId(null);
    setShowForm(false);
  }
  function saveExpense() {
    const payer = formFriends.find((f) => f.id === draft.payerId);
    if (!payer || !split.valid || !draft.name.trim() || Number(draft.price) <= 0 || !currency) return;
    const splitInputs = draft.method === "equal" ? undefined : Object.fromEntries(draft.selected.map((id) => [id, Number(draft.values[id] || 0)]));
    const expense: Expense = { id: editingExpenseId ?? uid(), name: draft.name.trim(), description: draft.description.trim(), price: cents(Number(draft.price)), currency, date: draft.date, payerId: payer.id, payerName: payer.name, method: draft.method, splits: split.lines, splitInputs };
    updateGroup((g) => ({ ...g, expenses: editingExpenseId ? g.expenses.map((item) => item.id === editingExpenseId ? expense : item) : [expense, ...g.expenses] }));
    setDrafts((old) => ({ ...old, [group.id]: blankDraft() }));
    setEditingExpenseId(null);
    setShowForm(false);
  }

  function exportPdf() {
    setExporting(true);
    const totals = currenciesInUse.map((c) => ({ c, total: group.expenses.filter((e) => e.currency === c).reduce((s, e) => s + e.price, 0) }));
    const useConversion = Boolean(group.settleInPrimary && conversionReady);
    const sections = useConversion
      ? `<section><h2>Settle up · ${escapeHtml(primaryCurrency)}</h2><p class="note">Converted using your manual rates: ${conversionCurrencies.map((code) => `1 ${escapeHtml(code)} = ${escapeHtml(exchangeRates[code])} ${escapeHtml(primaryCurrency)}`).join(" · ") || "No conversion needed"}</p>${settle(getConvertedBalances(group, primaryCurrency, exchangeRates)).map((s) => `<div class="payment"><b>${escapeHtml(s.from)}</b> pays <b>${escapeHtml(s.to)}</b><strong>${escapeHtml(money(s.amount, primaryCurrency))}</strong></div>`).join("") || "<p>Everyone is settled up.</p>"}</section>`
      : totals.map(({ c, total }) => { const payments = settle(getBalances(group, c)); return `<section><h2>Settle up · ${escapeHtml(c)}</h2><p class="note">${escapeHtml(money(total, c))} spent</p>${payments.length ? payments.map((s) => `<div class="payment"><b>${escapeHtml(s.from)}</b> pays <b>${escapeHtml(s.to)}</b><strong>${escapeHtml(money(s.amount, c))}</strong></div>`).join("") : "<p>Everyone is settled up.</p>"}</section>`; }).join("");
    const expenses = [...group.expenses].sort((a, b) => a.date.localeCompare(b.date)).map((e) => `<tr><td>${escapeHtml(e.date)}</td><td><b>${escapeHtml(e.name)}</b>${e.description ? `<small>${escapeHtml(e.description)}</small>` : ""}</td><td>${escapeHtml(e.payerName)}</td><td>${escapeHtml(money(e.price, e.currency))}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(group.name)} — Split</title><style>${reportCss}</style></head><body><header><div class="brand">SPLIT / REPORT</div><h1>${escapeHtml(group.name)}</h1><p>Generated ${escapeHtml(new Date().toLocaleString())}</p></header><main>${sections}<section><h2>Total spent</h2><div class="totals">${totals.map((t) => `<div><span>${escapeHtml(t.c)}</span><strong>${escapeHtml(money(t.total, t.c))}</strong></div>`).join("")}</div></section><section class="log"><h2>Expense log</h2><table><thead><tr><th>Date</th><th>Expense</th><th>Paid by</th><th>Amount</th></tr></thead><tbody>${expenses}</tbody></table></section></main></body></html>`;
    const win = window.open("", "_blank");
    if (!win) { setExporting(false); return; }
    win.document.write(html); win.document.close();
    setTimeout(() => { win.focus(); win.print(); setExporting(false); }, 350);
  }

  const canSave = formFriends.length >= 2 && Boolean(draft.name.trim()) && Number(draft.price) > 0 && Boolean(currency) && Boolean(draft.payerId) && split.valid;
  return <main className="min-h-screen bg-[#f7f8fa] text-[#172033]">
    <header className="sticky top-0 z-30 border-b border-[#e5e8ee] bg-white/95 backdrop-blur"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
      <div className="flex items-center gap-2.5"><img src="/split-icon.svg" alt="" width={36} height={36} className="h-9 w-9 shrink-0"/><span className="text-lg font-bold tracking-[-.03em]">Split</span></div>
      <div className="flex items-center gap-3"><span className={`hidden items-center gap-1.5 text-xs font-medium sm:flex ${sync === "local" ? "text-[#667085]" : "text-[#178250]"}`}><span className={`h-2 w-2 rounded-full ${sync === "saving" ? "animate-pulse bg-[#1769e0]" : sync === "synced" ? "bg-[#16a05d]" : "bg-[#98a2b3]"}`}/>{sync === "saving" ? "Saving…" : sync === "synced" ? "Synced" : "Local only"}</span><button onClick={exportPdf} disabled={exporting || !group.expenses.length || Boolean(group.settleInPrimary && !conversionReady)} className="secondary-button"><Download size={16}/>{exporting ? "Preparing…" : "Export PDF"}</button></div>
    </div></header>
    <div className="mx-auto max-w-6xl px-4 pb-24 pt-5 sm:px-6 sm:pt-8">
      <div className="group-tabs-shell"><div className="group-tabs">{data.groups.map((g) => <button key={g.id} onClick={() => { setData((d) => ({ ...d, activeGroupId: g.id })); setFriendError(""); setEditingExpenseId(null); setShowForm(false); }} className={`group-tab ${g.id === group.id ? "active" : ""}`}>{g.name}</button>)}</div><button onClick={addGroup} className="add-group-button" aria-label="Add group"><Plus size={17}/><span>New group</span></button></div>
      <section className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div className="min-w-0"><label className="eyebrow">Group name</label><input aria-label="Group name" value={group.name} onChange={(e) => updateGroup((g) => ({ ...g, name: e.target.value }))} className="group-name"/><p className="mt-1 text-sm text-[#667085]">{group.friends.length} {group.friends.length === 1 ? "friend" : "friends"} · {group.expenses.length} {group.expenses.length === 1 ? "expense" : "expenses"}</p></div><div className="flex items-center gap-2">{data.groups.length > 1 && <button onClick={removeGroup} className="secondary-button danger-button" aria-label={`Delete ${group.name}`}><Trash2 size={16}/>Delete group</button>}<button onClick={openAddExpense} disabled={group.friends.length < 2} className="primary-button"><Plus size={18}/>Add expense</button></div></section>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,.75fr)] lg:items-start"><div className="space-y-5">
        {currenciesInUse.length ? <section className="surface settle-surface"><div className="section-heading"><div><span className="eyebrow">Minimum payments</span><h2>Settle up</h2></div>{group.settleInPrimary && conversionReady && <span className="conversion-badge">Converted to {primaryCurrency}</span>}</div>
          <Tabs value={group.settleInPrimary ? "converted" : "original"} onValueChange={(value) => updateGroup((current) => ({ ...current, settleInPrimary: value === "converted" }))}>
            <TabsList aria-label="Settlement currency" className="settlement-tabs">
              <TabsTrigger value="original">Original currencies</TabsTrigger>
              <TabsTrigger value="converted">Converted currency</TabsTrigger>
            </TabsList>
            <TabsContent value="original" className="space-y-4 pt-3">{currenciesInUse.map((code) => { const payments = settle(getBalances(group, code)); return <div key={code}><h3 className="mb-2 text-sm font-semibold text-[#667085]">{code}</h3>{payments.length ? payments.map((payment,index) => <div key={index} className="settlement"><span>{payment.from}</span><ArrowRight size={15}/><span>{payment.to}</span><strong>{money(payment.amount,code)}</strong></div>) : <div className="empty-line"><Check size={16}/>Everyone is settled up</div>}</div>; })}</TabsContent>
            <TabsContent value="converted" className="space-y-5 pt-3">
              <div className="space-y-3">
                <label className="field"><span>Settle in</span><select className="input" value={primaryCurrency} onChange={(event) => updateGroup((current) => ({ ...current, primaryCurrency: event.target.value, exchangeRates: {} }))}>{primaryCurrencyOptions.map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
                {conversionCurrencies.map((code) => <label className="rate-field" key={code}><span>1 {code}</span><span>=</span><input aria-label={`Rate from ${code} to ${primaryCurrency}`} className="input" type="number" inputMode="decimal" min="0" step="any" placeholder="Rate" value={exchangeRates[code] ?? ""} onChange={(event) => updateGroup((current) => ({ ...current, exchangeRates: { ...(current.exchangeRates ?? {}), [code]: event.target.value } }))}/><span>{primaryCurrency}</span></label>)}
                <p className="text-sm text-[#667085]">Enter how much 1 unit of the original currency is worth in {primaryCurrency}. Payments update automatically; original expenses stay unchanged.</p>
              </div>
              {conversionReady ? (() => { const payments = settle(getConvertedBalances(group, primaryCurrency, exchangeRates)); return <div className="space-y-2" aria-live="polite"><h3 className="text-sm font-semibold">Payments in {primaryCurrency}</h3>{payments.length ? payments.map((payment,index) => <div key={index} className="settlement"><span>{payment.from}</span><ArrowRight size={15}/><span>{payment.to}</span><strong>{money(payment.amount,primaryCurrency)}</strong></div>) : <div className="empty-line"><Check size={16}/>Everyone is settled up</div>}</div>; })() : <p role="status" className="conversion-warning">Enter a positive rate for {conversionCurrencies.filter((code) => !Number.isFinite(Number(exchangeRates[code])) || Number(exchangeRates[code]) <= 0).join(", ")} to see converted payments.</p>}
            </TabsContent>
          </Tabs>
        </section> : <section className="empty-state"><div className="empty-icon"><CircleDollarSign size={25}/></div><h2>No expenses yet</h2><p>Add at least two friends, then log your first shared expense.</p>{group.friends.length >= 2 && <button onClick={openAddExpense} className="primary-button mt-5"><Plus size={18}/>Add expense</button>}</section>}
        <section className="surface"><div className="section-heading"><div><span className="eyebrow">History</span><h2>Expenses</h2></div><span className="count-pill">{group.expenses.length}</span></div>{group.expenses.length ? <div className="space-y-1">{group.expenses.map((e) => <article key={e.id} className="expense-row"><div className="date-box"><b>{new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined,{day:"2-digit"})}</b><span>{new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined,{month:"short"})}</span></div><div className="min-w-0 flex-1"><h3 className="truncate font-semibold">{e.name}</h3><p className="truncate text-sm text-[#667085]">Paid by {e.payerName}{e.description ? ` · ${e.description}` : ""}</p></div><div className="text-right"><strong className="block whitespace-nowrap">{money(e.price,e.currency)}</strong><span className="text-xs text-[#667085]">{methods.find((m)=>m.key===e.method)?.label}</span></div><div className="expense-actions"><button aria-label={`Edit ${e.name}`} onClick={() => openEditExpense(e)} className="icon-button"><Pencil size={15}/></button><button aria-label={`Remove ${e.name}`} onClick={() => updateGroup((g) => ({ ...g, expenses: g.expenses.filter((x) => x.id !== e.id) }))} className="icon-button"><Trash2 size={16}/></button></div></article>)}</div> : <p className="py-8 text-center text-sm text-[#98a2b3]">Your expense log will appear here.</p>}</section>
      </div>
      <aside className="surface lg:sticky lg:top-24"><div className="section-heading"><div><span className="eyebrow">This group</span><h2>Friends</h2></div><Users size={19} className="text-[#667085]"/></div><form onSubmit={(e) => { e.preventDefault(); addFriend(); }} className="flex gap-2"><input value={friendName} onChange={(e) => { setFriendName(e.target.value); setFriendError(""); }} placeholder="Add a name" aria-label="Friend name" className="input flex-1"/><button className="square-button" aria-label="Add friend"><UserPlus size={18}/></button></form>{friendError && <p className="mt-2 text-xs font-medium text-[#cf3f3f]">{friendError}</p>}<div className="mt-4 space-y-1">{group.friends.map((f) => <div key={f.id} className="friend-row"><span className="avatar">{f.name.slice(0,1).toLocaleUpperCase()}</span><span className="min-w-0 flex-1 truncate font-medium">{f.name}</span><button onClick={() => removeFriend(f.id)} aria-label={`Remove ${f.name}`} className="icon-button"><X size={15}/></button></div>)}</div>{!group.friends.length && <p className="mt-5 text-sm leading-6 text-[#667085]">Start with everyone who may pay or share an expense.</p>}</aside>
      </div>
    </div>
    {showForm && <div className="modal-wrap" role="dialog" aria-modal="true" aria-label={editingExpenseId ? "Edit expense" : "Add expense"}><button className="modal-backdrop" onClick={closeExpenseForm} aria-label="Close"/><section className="modal-panel"><div className="modal-head"><div><span className="eyebrow">{group.name}</span><h2>{editingExpenseId ? "Edit expense" : "Add expense"}</h2></div><button onClick={closeExpenseForm} className="icon-button"><X size={20}/></button></div><div className="modal-body">
      <div className="grid gap-4 sm:grid-cols-2"><label className="field sm:col-span-2"><span>Expense name</span><input autoFocus className="input" placeholder="e.g. Dinner" value={draft.name} onChange={(e) => updateDraft({name:e.target.value})}/></label><label className="field sm:col-span-2"><span>Description <i>optional</i></span><input className="input" placeholder="A short note" value={draft.description} onChange={(e) => updateDraft({description:e.target.value})}/></label><label className="field"><span>Price</span><input className="input" type="number" inputMode="decimal" min="0" step="0.01" placeholder="0.00" value={draft.price} onChange={(e) => updateDraft({price:e.target.value})}/></label><label className="field"><span>Currency</span><select className="input" value={draft.currency} onChange={(e) => updateDraft({currency:e.target.value})}>{currencies.map((c)=><option key={c}>{c}</option>)}</select></label>{draft.currency === "Other" && <label className="field sm:col-span-2"><span>Currency code</span><input className="input uppercase" maxLength={6} placeholder="e.g. THB" value={draft.otherCurrency} onChange={(e)=>updateDraft({otherCurrency:e.target.value.replace(/[^a-z]/gi,"")})}/></label>}<label className="field"><span>Date</span><input className="input" type="date" value={draft.date} onChange={(e)=>updateDraft({date:e.target.value})}/></label><label className="field"><span>Paid by</span><select className="input" value={draft.payerId} onChange={(e)=>updateDraft({payerId:e.target.value})}><option value="">Choose friend</option>{formFriends.map((f)=><option key={f.id} value={f.id}>{f.name}{!group.friends.some((friend)=>friend.id===f.id)?" (removed)":""}</option>)}</select></label></div><hr/>
      <div><span className="field-title">How should it be split?</span><div className="method-grid">{methods.map((m)=><button key={m.key} onClick={()=>updateDraft({method:m.key,values:{}})} className={draft.method===m.key ? "active" : ""}>{m.label}</button>)}</div></div>
      <div><div className="mb-2 flex items-center justify-between"><span className="field-title">Participants</span><button onClick={()=>updateDraft({selected: draft.selected.length===formFriends.length ? [] : formFriends.map((f)=>f.id)})} className="text-button">{draft.selected.length===formFriends.length ? "Clear" : "Select all"}</button></div><div className="participant-list">{formFriends.map((f)=>{const selected=draft.selected.includes(f.id);return <div key={f.id} className={`participant ${selected?"selected":""}`}><button className="participant-main" onClick={()=>updateDraft({selected:selected?draft.selected.filter((id)=>id!==f.id):[...draft.selected,f.id]})}><span className="check">{selected&&<Check size={13}/>}</span><span>{f.name}{!group.friends.some((friend)=>friend.id===f.id)&&<small className="removed-label">removed</small>}</span></button>{selected && draft.method!=="equal" && <div className="value-wrap"><input type="number" inputMode="decimal" min="0" step={draft.method==="percentage"?"1":"0.01"} value={draft.values[f.id]??""} onChange={(e)=>updateDraft({values:{...draft.values,[f.id]:e.target.value}})} aria-label={`${f.name} ${draft.method}`}/><span>{draft.method==="percentage"?"%":draft.method==="shares"?"share":""}</span></div>}</div>})}</div><div className={`split-status ${split.valid?"valid":""}`}><span>{split.status}</span>{split.valid&&<Check size={15}/>}</div></div>
    </div><div className="modal-foot"><button onClick={closeExpenseForm} className="secondary-button">Cancel</button><button onClick={saveExpense} disabled={!canSave} className="primary-button">{editingExpenseId ? "Save changes" : "Add expense"}</button></div></section></div>}
  </main>;
}

function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c] || c)); }
const reportCss = `@page{size:A4;margin:18mm}*{box-sizing:border-box}body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Arial,sans-serif;color:#172033;margin:0;font-size:12px}header{border-bottom:2px solid #1769e0;padding-bottom:18px;margin-bottom:22px}.brand{color:#1769e0;font-weight:800;font-size:10px;letter-spacing:.14em}h1{font-size:28px;margin:8px 0 4px}header p{color:#667085;margin:0}section{break-inside:avoid;margin:0 0 24px}h2{font-size:17px;margin:0 0 12px}h3{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#667085;margin:16px 0 8px}.totals{display:flex;gap:10px;flex-wrap:wrap}.totals div{border:1px solid #e5e8ee;border-radius:10px;padding:10px 14px;min-width:120px}.totals span{display:block;color:#667085;font-size:10px}.totals strong{font-size:17px}.row,.payment{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #edf0f4}.payment strong{margin-left:auto;color:#1769e0}.pos{color:#178250}.neg{color:#cf3f3f}table{border-collapse:collapse;width:100%}th{text-align:left;color:#667085;font-size:9px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #d7dce4;padding:8px 6px}td{padding:9px 6px;border-bottom:1px solid #edf0f4;vertical-align:top}td:last-child,th:last-child{text-align:right}small{display:block;color:#667085;margin-top:2px}.log{break-inside:auto}.log tr{break-inside:avoid}`;
