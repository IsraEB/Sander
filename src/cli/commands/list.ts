import type { CliDeps } from '../deps';
import { listBoxes, loadRegistry } from '../../registry/registry';
import type { Sandbox } from '../../registry/registry';
import type { PortMapping } from '../../provider/provider';
import { resolveProviderName } from '../../provider/providers';
import { containerNameForSandbox, dockerContainerName } from '../../names/sandbox-name';

function columnWidths(rows: string[][]): number[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col]?.length ?? 0)));
  return widths;
}

function renderRows(rows: string[][]): string {
  const widths = columnWidths(rows);
  return rows
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd())
    .join('\n');
}

interface PortsResult {
  ports: PortMapping[];
  ok: boolean;
}

const formatPort = (p: PortMapping): string => (p.container !== undefined ? `${p.host}->${p.container}` : p.host);

async function readPorts(deps: CliDeps, box: Sandbox): Promise<PortsResult> {
  try {
    return { ports: await deps.createProvider(box.provider).ports(box.id), ok: true };
  } catch {
    return { ports: [], ok: false };
  }
}

// The PROVIDER column shows the canonical engine name: a legacy registry value
// like `agentbox` renders as the docker provider it resolves to. Unknown values
// fall back to the raw registry text so a stale box never hides the list.
function displayProvider(raw: string): string {
  try {
    return resolveProviderName(raw);
  } catch {
    return raw;
  }
}

// A box without the yolo field predates ticket 04 and defaults to yolo.
function yoloLabel(box: Sandbox): string {
  return box.yolo ?? true ? 'sí' : 'no';
}

export async function runList(deps: CliDeps): Promise<number> {
  const registry = loadRegistry(deps.configDir);
  const boxes = listBoxes(registry);
  if (boxes.length === 0) {
    deps.stdout.write('No sandboxes found.\n');
    return 0;
  }
  const portsResults = await Promise.all(boxes.map((b: Sandbox) => readPorts(deps, b)));
  if (portsResults.some((r) => !r.ok)) {
    deps.stderr.write('Aviso: no se pudieron leer los puertos de algún sandbox.\n');
  }
  const realNames = boxes.map((b: Sandbox) => b.containerName ?? containerNameForSandbox(b.id));
  const anyMapped = realNames.some((name, i) => name !== boxes[i].id);
  const header = anyMapped
    ? ['ID', 'REAL CONTAINER', 'PROVIDER', 'HARNESS', 'YOLO', 'STATUS', 'PORTS']
    : ['ID', 'PROVIDER', 'HARNESS', 'YOLO', 'STATUS', 'PORTS'];
  const rows = boxes.map((b: Sandbox, i: number) => {
    const cells = [
      b.id,
      displayProvider(b.provider),
      b.harness,
      yoloLabel(b),
      b.status,
      portsResults[i].ports.length > 0 ? portsResults[i].ports.map(formatPort).join(',') : '—',
    ];
    return anyMapped ? [b.id, dockerContainerName(realNames[i]), ...cells.slice(1)] : cells;
  });
  deps.stdout.write(`${renderRows([header, ...rows])}\n`);
  return 0;
}
