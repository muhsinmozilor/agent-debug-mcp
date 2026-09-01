import { DevtoolsError, type Capability, type TabHandle, type TabInfo, type ToolDescriptor } from '@devtools-mcp/protocol';

export interface TabRecord extends TabInfo {
  tools: Map<string, ToolDescriptor>;
  /** Set when the extension connection dropped; the tab is removed if not re-announced in time. */
  staleSince?: number;
}

export class TabRegistry {
  private tabs = new Map<TabHandle, TabRecord>();

  list(): TabRecord[] {
    return [...this.tabs.values()].filter((t) => t.staleSince === undefined);
  }

  get(tab: TabHandle): TabRecord | undefined {
    const t = this.tabs.get(tab);
    return t && t.staleSince === undefined ? t : undefined;
  }

  upsert(info: TabInfo): TabRecord {
    const prev = this.tabs.get(info.tab as TabHandle);
    const rec: TabRecord = {
      ...info,
      tools: prev && prev.doc === info.doc ? prev.tools : new Map(),
    };
    this.tabs.set(info.tab as TabHandle, rec);
    return rec;
  }

  navigate(tab: TabHandle, doc: string, url: string, title: string): void {
    const prev = this.tabs.get(tab);
    if (!prev) return;
    this.tabs.set(tab, { ...prev, doc, url, title, capabilities: [], registryGen: 0, tools: new Map(), state: 'attached' });
    delete this.tabs.get(tab)!.staleSince;
  }

  setState(tab: TabHandle, state: 'attached' | 'frozen'): void {
    const t = this.tabs.get(tab);
    if (t) t.state = state;
  }

  setRegistry(tab: TabHandle, doc: string, gen: number, capabilities: Capability[], tools: ToolDescriptor[] | null, removed: string[] = []): void {
    const t = this.tabs.get(tab);
    if (!t) return;
    if (t.doc !== doc) return; // late frame from a previous document
    t.capabilities = capabilities;
    t.registryGen = gen;
    if (tools) {
      if (removed.length === 0 && tools.length > 0 && t.tools.size === 0) t.tools = new Map();
      for (const d of tools) t.tools.set(d.name, d);
    }
    for (const name of removed) t.tools.delete(name);
  }

  replaceRegistry(tab: TabHandle, doc: string, gen: number, capabilities: Capability[], tools: ToolDescriptor[]): void {
    const t = this.tabs.get(tab);
    if (!t || t.doc !== doc) return;
    t.capabilities = capabilities;
    t.registryGen = gen;
    t.tools = new Map(tools.map((d) => [d.name, d]));
  }

  remove(tab: TabHandle): void {
    this.tabs.delete(tab);
  }

  /** Mark every tab stale (extension connection lost). Call `pruneStale` after the grace period. */
  markAllStale(now = Date.now()): void {
    for (const t of this.tabs.values()) t.staleSince ??= now;
  }

  /** Reconcile with a fresh snapshot from a (re)connected extension. */
  applySnapshot(tabs: TabInfo[]): void {
    const seen = new Set<TabHandle>();
    for (const info of tabs) {
      seen.add(info.tab as TabHandle);
      const prev = this.tabs.get(info.tab as TabHandle);
      const rec = this.upsert(info);
      if (prev && prev.doc === info.doc) rec.tools = prev.tools;
      delete rec.staleSince;
    }
    for (const [h, t] of this.tabs) if (!seen.has(h) && t.staleSince !== undefined) this.tabs.delete(h);
  }

  pruneStale(graceMs: number, now = Date.now()): TabHandle[] {
    const removed: TabHandle[] = [];
    for (const [h, t] of this.tabs) {
      if (t.staleSince !== undefined && now - t.staleSince > graceMs) {
        this.tabs.delete(h);
        removed.push(h);
      }
    }
    return removed;
  }

  /**
   * Pure tab resolution: explicit handle → the sole attached tab → AMBIGUOUS_TAB with candidates.
   */
  resolve(tab: string | undefined): TabRecord {
    if (tab !== undefined) {
      const rec = this.get(tab as TabHandle);
      if (!rec) {
        throw new DevtoolsError('TAB_NOT_FOUND', `Tab "${tab}" is not attached`, {
          hint: 'Call tabs_list to see attached tabs.',
          data: { tabs: this.summaries() },
        });
      }
      if (rec.state === 'frozen') {
        throw new DevtoolsError('TAB_FROZEN', `Tab "${tab}" is in the back/forward cache`, { hint: 'Activate the tab or navigate to it, then retry.' });
      }
      return rec;
    }
    const live = this.list().filter((t) => t.state === 'attached');
    if (live.length === 1) return live[0] as TabRecord;
    if (live.length === 0) {
      throw new DevtoolsError('TAB_NOT_FOUND', 'No tabs are attached', {
        hint: 'Open your app on localhost in Chrome with the Agent Debug MCP extension enabled, then call tabs_list.',
      });
    }
    throw new DevtoolsError('AMBIGUOUS_TAB', `${live.length} tabs are attached; pass "tab" explicitly`, {
      data: { tabs: this.summaries() },
    });
  }

  summaries(): { tab: string; url: string; title: string; capabilities: Capability[]; active: boolean; state: string }[] {
    return this.list().map((t) => ({ tab: t.tab, url: t.url, title: t.title, capabilities: t.capabilities, active: t.active, state: t.state }));
  }
}
