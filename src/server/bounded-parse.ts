import type { ConversationItem, ToolCall } from "../shared/types.js";
import { truncateText } from "./text.js";

export interface BoundedParseOptions {
  compactItems?: boolean;
  retainItems?: boolean;
  onItem?: (item: Omit<ConversationItem, "id">) => void;
}

export class BoundedItemCollector {
  private readonly conversation: HeadTailBuffer<Omit<ConversationItem, "id">>;
  private readonly trace: HeadTailBuffer<Omit<ConversationItem, "id">>;

  constructor(private readonly options: BoundedParseOptions = {}) {
    const limit = options.retainItems === false ? 0 : undefined;
    this.conversation = new HeadTailBuffer(limit);
    this.trace = new HeadTailBuffer(limit);
  }

  add(item: Omit<ConversationItem, "id">): Omit<ConversationItem, "id"> {
    const conversation = item.role === "user" || item.role === "assistant";
    let prepared = item;
    if (this.shouldCompact()) {
      const text = truncateText(item.text, conversation ? 12_000 : 2_000);
      const summary = truncateText(item.summary, 2_000);
      prepared = {
        ...item,
        text,
        summary,
        usageJson: truncateText(item.usageJson, 4_000),
        providerMetadataJson: null,
        rawJson: undefined,
        contentPreview: Boolean(item.contentPreview) || text !== item.text || summary !== item.summary
      };
    }
    this.options.onItem?.(prepared);
    (conversation ? this.conversation : this.trace).add(prepared);
    return prepared;
  }

  values(): Array<Omit<ConversationItem, "id">> {
    return [...this.conversation.values(), ...this.trace.values()].sort((left, right) => left.sequence - right.sequence);
  }

  get deferredCount(): number {
    return this.conversation.deferredCount + this.trace.deferredCount;
  }

  private shouldCompact(): boolean {
    return Boolean(this.options.compactItems);
  }
}

export class HeadTailBuffer<T> {
  private readonly all: T[] | null;
  private readonly head: T[] = [];
  private readonly tail: T[];
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private tailStart = 0;
  private tailSize = 0;
  private total = 0;

  constructor(limit?: number) {
    this.all = limit == null ? [] : null;
    this.headLimit = limit == null ? 0 : Math.ceil(Math.max(0, limit) / 2);
    this.tailLimit = limit == null ? 0 : Math.floor(Math.max(0, limit) / 2);
    this.tail = this.tailLimit ? new Array<T>(this.tailLimit) : [];
  }

  add(value: T): void {
    this.total += 1;
    if (this.all) {
      this.all.push(value);
      return;
    }
    if (this.head.length < this.headLimit) {
      this.head.push(value);
      return;
    }
    if (this.tailLimit === 0) return;
    if (this.tailSize < this.tailLimit) {
      this.tail[this.tailSize++] = value;
      return;
    }
    this.tail[this.tailStart] = value;
    this.tailStart = (this.tailStart + 1) % this.tailLimit;
  }

  values(): T[] {
    if (this.all) return [...this.all];
    const orderedTail = this.tailSize < this.tailLimit
      ? this.tail.slice(0, this.tailSize)
      : [...this.tail.slice(this.tailStart), ...this.tail.slice(0, this.tailStart)];
    return [...this.head, ...orderedTail];
  }

  get deferredCount(): number {
    return Math.max(0, this.total - (this.all?.length ?? this.head.length + this.tailSize));
  }
}

export class BoundedMap<K, V> {
  private readonly values = new Map<K, V>();

  constructor(private readonly limit?: number) {}

  get(key: K): V | undefined {
    return this.values.get(key);
  }

  has(key: K): boolean {
    return this.values.has(key);
  }

  set(key: K, value: V): void {
    if (!this.values.has(key) && this.limit != null && this.values.size >= this.limit) {
      const oldest = this.values.keys().next().value as K | undefined;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    this.values.set(key, value);
  }
}

export type ParsedTool = Omit<ToolCall, "id" | "cwd" | "archiveState">;

export class SearchTextCollector {
  private readonly chunks: string[] = [];
  private length = 0;

  add(values: Array<string | null | undefined>): void {
    for (const value of values) {
      if (!value || this.length >= 1_000_000) continue;
      const remaining = 1_000_000 - this.length;
      this.chunks.push(value.length <= remaining ? value : value.slice(0, remaining));
      this.length += Math.min(value.length, remaining) + 1;
    }
  }

  value(): string {
    return this.chunks.join("\n");
  }
}
