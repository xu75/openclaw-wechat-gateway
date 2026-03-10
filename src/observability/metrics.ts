export interface CounterMetric {
  name: string;
  value?: number;
  labels?: Record<string, string>;
}

export interface CounterSample {
  name: string;
  value: number;
  labels: Record<string, string>;
  updated_at: string;
}

export interface MetricsExporter {
  emitCounter(sample: CounterSample): void;
}

export class InMemoryMetricsRegistry {
  private readonly counters = new Map<string, CounterSample>();

  emitCounter(metric: CounterMetric): CounterSample {
    const normalized = normalizeCounter(metric);
    const key = counterKey(normalized.name, normalized.labels);
    const current = this.counters.get(key);
    const nextValue = (current?.value ?? 0) + normalized.value;
    const sample: CounterSample = {
      name: normalized.name,
      labels: normalized.labels,
      value: nextValue,
      updated_at: new Date().toISOString()
    };
    this.counters.set(key, sample);
    return sample;
  }

  getCounter(name: string, labels: Record<string, string> = {}): number {
    const key = counterKey(name, labels);
    return this.counters.get(key)?.value ?? 0;
  }

  snapshot(): CounterSample[] {
    return Array.from(this.counters.values()).sort((a, b) => {
      if (a.name === b.name) {
        return labelsKey(a.labels).localeCompare(labelsKey(b.labels));
      }
      return a.name.localeCompare(b.name);
    });
  }

  reset(): void {
    this.counters.clear();
  }
}

const defaultRegistry = new InMemoryMetricsRegistry();
let exporter: MetricsExporter | null = null;

export function setMetricsExporter(nextExporter: MetricsExporter | null): void {
  exporter = nextExporter;
}

export function emitCounter(metric: CounterMetric): void {
  const sample = defaultRegistry.emitCounter(metric);
  exporter?.emitCounter(sample);
}

export function getCounter(name: string, labels: Record<string, string> = {}): number {
  return defaultRegistry.getCounter(name, labels);
}

export function metricsSnapshot(): CounterSample[] {
  return defaultRegistry.snapshot();
}

export function resetMetrics(): void {
  defaultRegistry.reset();
}

function normalizeCounter(metric: CounterMetric): { name: string; value: number; labels: Record<string, string> } {
  const name = metric.name.trim();
  if (!name) {
    throw new Error('metric name must not be empty');
  }

  const value = metric.value ?? 1;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('counter value must be a positive number');
  }

  const labels: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(metric.labels ?? {})) {
    const normalizedKey = key.trim();
    const normalizedValue = rawValue.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    labels[normalizedKey] = normalizedValue;
  }

  return {
    name,
    value,
    labels
  };
}

function counterKey(name: string, labels: Record<string, string>): string {
  return `${name}::${labelsKey(labels)}`;
}

function labelsKey(labels: Record<string, string>): string {
  const items = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return items.map(([key, value]) => `${key}=${value}`).join(',');
}
