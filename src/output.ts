/**
 * Structured output formatting: YAML by default, JSON when explicitly requested.
 */

import yaml from 'js-yaml';

export interface RenderOptions {
  fmt?: string;
}

export function render(data: unknown, opts: RenderOptions = {}): void {
  const fmt = opts.fmt ?? 'yaml';
  if (data === null || data === undefined) {
    console.log(data);
    return;
  }
  if (fmt === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  renderYaml(data);
}

function renderYaml(data: unknown): void {
  console.log(yaml.dump(data, { sortKeys: false, lineWidth: 120, noRefs: true }));
}
