import type { ElementInput, ElementPatch, Operation, PreparedAssetRef, Snapshot } from '../model/types';
import { err, ok, PlanError, fail, type Result } from '../model/result';
import { toPoints, type Unit } from '../model/units';
import { PAGE_PRESETS } from '../model/defaults';
import type { CompiledScript } from '../commands/CommandEngine';
import { planOperations } from '../commands/planPatch';
import { parse, type ScriptCommand } from './parser';
import type { Span, Token } from './lexer';

export type CompileContext = { snapshot: Snapshot; newUuid: () => string; preparedAssetRefs?: Record<string, PreparedAssetRef> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const COLOUR = /^(none|#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?)$/;
const DIM = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(pt|mm|cm|in|px)$/;
const ANGLE = /^(-?(?:\d+\.?\d*|\.\d+))(deg)?$/;
const MAX_OPS = 1000;

type Known = { id: string; kind: string; pageId: string };

/**
 * DrawScript compiler: side-effect free, no eval, no IO. Resolves every alias/name to a UUID
 * against the captured snapshot plus elements created earlier in the script, so the compiled
 * batch is independent of batch page scope. `page use` is compile context only.
 */
class Compiler {
  readonly ops: Operation[] = [];
  readonly spans: Span[] = [];
  private page: string;
  private readonly pages: { id: string; name: string }[];
  private readonly aliases = new Map<string, Map<string, string>>(); // pageId → alias → id
  private readonly known = new Map<string, Known>();
  private readonly names = new Map<string, Map<string, string[]>>(); // pageId → name → ids
  private span!: Span;

  constructor(private readonly ctx: CompileContext) {
    const doc = ctx.snapshot.document;
    this.pages = doc.pages.map((p) => ({ id: p.id, name: p.name }));
    this.page = doc.pages.find((p) => p.id === ctx.snapshot.pageId)?.id ?? doc.pages[0].id;
    for (const p of doc.pages) {
      const a = new Map<string, string>(), n = new Map<string, string[]>();
      for (const e of p.elements) {
        this.known.set(e.id, { id: e.id, kind: e.kind, pageId: p.id });
        if (e.alias) a.set(e.alias, e.id);
        if (e.name) n.set(e.name, [...(n.get(e.name) ?? []), e.id]);
      }
      this.aliases.set(p.id, a);
      this.names.set(p.id, n);
    }
  }

  private error(message: string, t?: Token | Span): never {
    const s = t ? ('span' in t ? t.span : t) : this.span;
    return fail('invalid_request', `line ${s.line}, column ${s.column}: ${message}`, { line: s.line, column: s.column });
  }

  private emit(op: Operation) {
    if (this.ops.length >= MAX_OPS) fail('limit_exceeded', `script compiles to more than ${MAX_OPS} operations`, { line: this.span.line, column: this.span.column });
    this.ops.push(op);
    this.spans.push(this.span);
  }

  // ---------- typed values ----------
  private text(t: Token): string {
    if (t.kind === 'kv') this.error('unexpected key=value', t);
    return t.text;
  }
  private dim(t: Token, key: string): number {
    const m = DIM.exec(this.text(t));
    if (!m) this.error(`${key} needs a dimension with a unit (pt, mm, cm, in, px), got "${this.text(t)}"`, t);
    return toPoints(Number(m[1]), m[2] as Unit);
  }
  private num(t: Token, key: string): number {
    const v = Number(this.text(t));
    if (t.kind !== 'word' || !Number.isFinite(v)) this.error(`${key} needs a number`, t);
    return v;
  }
  private angle(t: Token, key: string): number {
    const m = ANGLE.exec(this.text(t));
    if (!m || t.kind !== 'word') this.error(`${key} needs degrees, e.g. 30 or 30deg`, t);
    return Number(m[1]);
  }
  private bool(t: Token, key: string): boolean {
    if (t.kind === 'word' && (t.text === 'true' || t.text === 'false')) return t.text === 'true';
    return this.error(`${key} needs true or false`, t);
  }
  private colour(t: Token, key: string): string {
    const v = this.text(t);
    if (!COLOUR.test(v)) this.error(`${key} needs "#RRGGBB", "#RRGGBBAA" or none (quote colours: unquoted # starts a comment)`, t);
    return v;
  }
  private oneOf<T extends string>(t: Token, key: string, values: readonly T[]): T {
    const v = this.text(t) as T;
    if (!values.includes(v)) this.error(`${key} must be one of ${values.join(', ')}`, t);
    return v;
  }

  // ---------- targets ----------
  private pageByRef(ref: string, t: Token): string {
    const byId = this.pages.find((p) => p.id === ref);
    if (byId) return byId.id;
    const byName = this.pages.filter((p) => p.name === ref);
    if (byName.length > 1) this.error(`page name "${ref}" is ambiguous`, t);
    if (!byName[0]) this.error(`page "${ref}" not found`, t);
    return byName[0].id;
  }

  private tryResolve(ref: string): string | undefined {
    if (UUID.test(ref)) return this.known.has(ref) ? ref : undefined;
    const a = this.aliases.get(this.page)?.get(ref);
    if (a) return a;
    const n = this.names.get(this.page)?.get(ref) ?? [];
    if (n.length > 1) fail('ambiguous_target', `line ${this.span.line}: name "${ref}" matches ${n.length} elements`, { line: this.span.line, column: this.span.column, candidates: n });
    return n[0];
  }

  private target(t: Token): string {
    const ref = this.text(t);
    const id = this.tryResolve(ref);
    if (!id) this.error(`no element "${ref}" on page ${this.pages.find((p) => p.id === this.page)?.name}`, t);
    return id;
  }

  private targets(tokens: Token[]): string[] {
    if (!tokens.length) this.error('needs at least one target');
    return tokens.map((t) => this.target(t));
  }

  /** "a.south": whole alias first, then the last-dot port suffix. Quoted dotted aliases need fromPort=/toPort=. */
  private endpoint(t: Token, port?: Token) {
    const ref = this.text(t);
    const whole = this.tryResolve(ref);
    if (whole) return { target: whole, ...(port ? { port: this.text(port) } : {}) };
    if (t.kind === 'word' && ref.includes('.')) {
      const cut = ref.lastIndexOf('.');
      const id = this.tryResolve(ref.slice(0, cut));
      if (id) {
        if (port) this.error('give the port either as alias.port or as a separate port field, not both', t);
        return { target: id, port: ref.slice(cut + 1) };
      }
    }
    return this.error(`no element "${ref}" for endpoint`, t);
  }

  private defineAlias(alias: string, id: string, kind: string, t: Token) {
    if (!ALIAS.test(alias)) this.error(`invalid alias "${alias}"`, t);
    const table = this.aliases.get(this.page)!;
    if (table.has(alias)) this.error(`alias "${alias}" already exists on this page`, t);
    table.set(alias, id);
    this.known.set(id, { id, kind, pageId: this.page });
  }

  private forget(id: string) {
    for (const table of this.aliases.values()) for (const [a, x] of table) if (x === id) table.delete(a);
    this.known.delete(id);
  }

  // ---------- properties ----------
  private props(c: ScriptCommand, kind: string, allowed: Set<string>, patch: ElementPatch & ElementInput, skip: Set<string>) {
    const style: Record<string, unknown> = {}, text: Record<string, unknown> = {}, bounds: Record<string, number> = {}, geometry: Record<string, unknown> = {};
    const textKey = kind === 'connector' ? 'label' : 'text';
    for (const [key, v] of c.named) {
      if (skip.has(key)) continue;
      if (!allowed.has(key)) this.error(`unknown field ${key}= for ${c.verb.join(' ')}`, (v as any).keySpan ?? v.span);
      switch (key) {
        case 'fill': style.fill = this.colour(v, key); break;
        case 'stroke': style.stroke = this.colour(v, key); break;
        case 'strokeWidth': style.strokeWidthPt = this.dim(v, key); break;
        case 'fillOpacity': style.fillOpacity = this.num(v, key); break;
        case 'dash': style.dash = this.oneOf(v, key, ['solid', 'dash', 'dot', 'dashDot'] as const); break;
        case 'startArrow': case 'endArrow': style[key] = this.oneOf(v, key, ['none', 'triangle', 'open', 'diamond', 'circle'] as const); break;
        case 'text': case 'label': text.value = this.text(v); break;
        case 'font': text.fontFamily = this.text(v); break;
        case 'fontSize': text.fontSizePt = this.dim(v, key); break;
        case 'bold': case 'italic': case 'underline': case 'wrap': text[key] = this.bool(v, key); break;
        case 'color': case 'colour': text.colour = this.colour(v, key); break;
        case 'align': text.horizontalAlign = this.oneOf(v, key, ['left', 'center', 'right'] as const); break;
        case 'valign': text.verticalAlign = this.oneOf(v, key, ['top', 'middle', 'bottom'] as const); break;
        case 'padding': text.paddingPt = this.dim(v, key); break;
        case 'x': bounds.x = this.dim(v, key); break;
        case 'y': bounds.y = this.dim(v, key); break;
        case 'w': bounds.width = this.dim(v, key); break;
        case 'h': bounds.height = this.dim(v, key); break;
        case 'type': geometry.preset = this.text(v); break;
        case 'radius': geometry.cornerRadiusPt = this.dim(v, key); break;
        case 'name': patch.name = this.text(v); break;
        case 'alias': patch.alias = this.text(v); break;
        case 'locked': patch.locked = this.bool(v, key); break;
        case 'hidden': patch.hidden = this.bool(v, key); break;
        case 'asset': patch.assetId = this.text(v); break;
        case 'fit': patch.fit = this.oneOf(v, key, ['contain', 'cover', 'stretch'] as const); break;
        case 'opacity': patch.opacity = this.num(v, key); break;
        case 'route': patch.route = this.oneOf(v, key, ['straight', 'orthogonal', 'curved'] as const); break;
        case 'rotation': patch.rotationDeg = this.angle(v, key); break;
        default: this.error(`unknown field ${key}=`, v);
      }
    }
    if (Object.keys(style).length) patch.style = style as any;
    if (Object.keys(text).length) (patch as any)[textKey] = text;
    if (Object.keys(geometry).length) patch.geometry = geometry as any;
    return bounds;
  }

  private static readonly STYLE = ['fill', 'stroke', 'strokeWidth', 'fillOpacity', 'dash'];
  private static readonly TEXT = ['text', 'font', 'fontSize', 'bold', 'italic', 'underline', 'wrap', 'color', 'colour', 'align', 'valign', 'padding'];
  private static readonly COMMON = ['name', 'alias', 'locked', 'hidden'];

  // ---------- commands ----------
  compile(commands: ScriptCommand[]) {
    for (const c of commands) {
      this.span = c.span;
      const verb = c.verb.join(' ');
      const named = (k: string) => c.named.get(k);
      switch (verb) {
        case 'page use': {
          const ref = c.positional[0] ?? named('name');
          if (!ref) this.error('page use needs a page name');
          this.page = this.pageByRef(this.text(ref), ref);
          break;
        }
        case 'page add': {
          const id = this.ctx.newUuid();
          const name = named('name') ? this.text(named('name')!) : c.positional[0] ? this.text(c.positional[0]) : undefined;
          this.emit({ op: 'addPage', page: { id, ...(name ? { name } : {}), ...(named('w') ? { widthPt: this.dim(named('w')!, 'w') } : {}), ...(named('h') ? { heightPt: this.dim(named('h')!, 'h') } : {}) } });
          this.pages.push({ id, name: name ?? `Page-${this.pages.length + 1}` });
          this.aliases.set(id, new Map());
          this.names.set(id, new Map());
          break;
        }
        case 'page rename': {
          const name = named('name') ?? c.positional[0];
          if (!name) this.error('page rename needs a new name');
          this.emit({ op: 'setPage', pageId: this.page, patch: { name: this.text(name) } });
          this.pages.find((p) => p.id === this.page)!.name = this.text(name);
          break;
        }
        case 'page size': {
          const preset = named('preset') ? this.text(named('preset')!) : c.positional.map((t) => this.text(t)).join(' ');
          if (preset) {
            const p = PAGE_PRESETS[preset];
            if (!p) this.error(`unknown page size "${preset}" (${Object.keys(PAGE_PRESETS).join(', ')})`);
            this.emit({ op: 'setPage', pageId: this.page, patch: { ...p } });
          } else {
            if (!named('w') || !named('h')) this.error('page size needs w= and h= or a preset');
            this.emit({ op: 'setPage', pageId: this.page, patch: { widthPt: this.dim(named('w')!, 'w'), heightPt: this.dim(named('h')!, 'h') } });
          }
          break;
        }
        case 'add shape': case 'add text': case 'add image': {
          const kind = c.verb[1] as 'shape' | 'text' | 'image';
          const allowed = new Set([...Compiler.COMMON, 'x', 'y', 'w', 'h', 'rotation', 'id', 'uuid', 'layer',
            ...(kind === 'image' ? ['asset', 'fit', 'opacity'] : [...Compiler.STYLE, ...Compiler.TEXT, ...(kind === 'shape' ? ['type', 'radius'] : [])])]);
          const input: any = { kind };
          const bounds = this.props(c, kind, allowed, input, new Set(['id', 'uuid', 'layer']));
          for (const k of ['x', 'y', 'width', 'height']) if (bounds[k] === undefined) this.error(`add ${kind} needs x=, y=, w= and h=`);
          input.bounds = bounds;
          const id = named('uuid') ? this.text(named('uuid')!) : this.ctx.newUuid();
          if (!UUID.test(id)) this.error('uuid= must be a UUID', named('uuid'));
          if (this.known.has(id)) this.error(`element ${id} already exists`, named('uuid'));
          input.id = id;
          const alias = named('id') ?? (input.alias ? undefined : undefined);
          if (alias) { input.alias = this.text(alias); this.defineAlias(input.alias, id, kind, alias); }
          else if (input.alias) this.defineAlias(input.alias, id, kind, c.named.get('alias')!);
          else this.known.set(id, { id, kind, pageId: this.page });
          if (named('layer')) input.layerIds = [this.text(named('layer')!)];
          if (kind === 'image' && !input.assetId) this.error('add image needs asset="asset:…"');
          this.emit({ op: 'create', pageId: this.page, element: input });
          break;
        }
        case 'connect': {
          const from = named('from'), to = named('to');
          if (!from || !to) this.error('connect needs from= and to=');
          const input: any = { kind: 'connector', from: this.endpoint(from, named('fromPort')), to: this.endpoint(to, named('toPort')) };
          this.props(c, 'connector', new Set([...Compiler.COMMON, 'id', 'uuid', 'from', 'to', 'fromPort', 'toPort', 'route', 'label', 'stroke', 'strokeWidth', 'dash', 'startArrow', 'endArrow', 'font', 'fontSize', 'color', 'colour', 'bold', 'italic']), input, new Set(['id', 'uuid', 'from', 'to', 'fromPort', 'toPort']));
          const id = named('uuid') ? this.text(named('uuid')!) : this.ctx.newUuid();
          input.id = id;
          if (named('id')) { input.alias = this.text(named('id')!); this.defineAlias(input.alias, id, 'connector', named('id')!); }
          else this.known.set(id, { id, kind: 'connector', pageId: this.page });
          this.emit({ op: 'create', pageId: this.page, element: input });
          break;
        }
        case 'group': {
          const id = this.ctx.newUuid();
          const targets = this.targets(c.positional);
          const alias = named('id');
          if (alias) this.defineAlias(this.text(alias), id, 'group', alias);
          else this.known.set(id, { id, kind: 'group', pageId: this.page });
          this.emit({ op: 'group', targets, id, ...(alias ? { alias: this.text(alias) } : {}) });
          break;
        }
        case 'ungroup':
          this.emit({ op: 'ungroup', target: this.target(c.positional[0] ?? this.error('ungroup needs a target')) });
          break;
        case 'set': {
          const t = c.positional[0];
          if (!t || c.positional.length > 1) this.error('set needs exactly one target followed by key=value pairs');
          const id = this.target(t);
          const kind = this.known.get(id)?.kind ?? 'shape';
          const patch: any = {};
          const allowed = new Set([...Compiler.COMMON, 'rotation', 'x', 'y', 'w', 'h',
            ...(kind === 'image' ? ['asset', 'fit', 'opacity'] : kind === 'connector' ? ['route', 'label', 'stroke', 'strokeWidth', 'dash', 'startArrow', 'endArrow', 'font', 'fontSize', 'color', 'colour', 'bold', 'italic', 'underline'] : kind === 'group' ? [] : [...Compiler.STYLE, ...Compiler.TEXT, 'type', 'radius'])]);
          const bounds = this.props(c, kind, allowed, patch, new Set());
          if (Object.keys(bounds).length) patch.bounds = bounds;
          if (!Object.keys(patch).length) this.error('set needs at least one property');
          if (patch.alias !== undefined) {
            this.forget(id);
            this.defineAlias(patch.alias, id, kind, c.named.get('alias')!);
          }
          this.emit({ op: 'set', target: id, patch });
          break;
        }
        case 'move': {
          const id = this.target(c.positional[0] ?? this.error('move needs a target'));
          const abs = named('x') || named('y'), rel = named('dx') || named('dy');
          if (abs && rel) this.error('move takes x=/y= or dx=/dy=, not both');
          if (abs) {
            if (!named('x') || !named('y')) this.error('absolute move needs both x= and y=');
            this.emit({ op: 'move', target: id, to: { xPt: this.dim(named('x')!, 'x'), yPt: this.dim(named('y')!, 'y') } });
          } else if (rel) {
            this.emit({ op: 'move', target: id, delta: { xPt: named('dx') ? this.dim(named('dx')!, 'dx') : 0, yPt: named('dy') ? this.dim(named('dy')!, 'dy') : 0 } });
          } else this.error('move needs x=/y= or dx=/dy=');
          this.unknownKeys(c, ['x', 'y', 'dx', 'dy']);
          break;
        }
        case 'resize': {
          const id = this.target(c.positional[0] ?? this.error('resize needs a target'));
          if (!named('w') && !named('h')) this.error('resize needs w= and/or h=');
          this.unknownKeys(c, ['w', 'h']);
          this.emit({ op: 'resize', target: id, ...(named('w') ? { widthPt: this.dim(named('w')!, 'w') } : {}), ...(named('h') ? { heightPt: this.dim(named('h')!, 'h') } : {}) });
          break;
        }
        case 'rotate': {
          const t = c.positional[0] ?? this.error('rotate needs a target');
          const id = this.target(t);
          const isGroup = this.known.get(id)?.kind === 'group';
          const angle = named('angle'), by = named('by');
          this.unknownKeys(c, ['angle', 'by', 'pivotX', 'pivotY']);
          if (angle && by) this.error('rotate takes angle= or by=, not both');
          if (!angle && !by) this.error('rotate needs angle= or by=');
          if (angle && isGroup) this.error('groups rotate relatively: use by=<degrees> (a group\'s own rotation stays 0)', angle);
          const px = named('pivotX'), py = named('pivotY');
          if ((px && !py) || (!px && py)) this.error('pivot needs both pivotX= and pivotY=');
          if (px && !isGroup) this.error('pivot is only valid for groups; other elements rotate about their own centre', px);
          this.emit(angle
            ? { op: 'rotate', target: id, angleDeg: this.angle(angle, 'angle') }
            : { op: 'rotate', target: id, deltaDeg: this.angle(by!, 'by'), ...(px ? { pivot: { xPt: this.dim(px, 'pivotX'), yPt: this.dim(py!, 'pivotY') } } : {}) });
          break;
        }
        case 'delete': {
          const id = this.target(c.positional[0] ?? this.error('delete needs a target'));
          this.unknownKeys(c, ['connectors', 'subtree']);
          this.emit({ op: 'delete', target: id, ...(named('connectors') ? { connectors: this.oneOf(named('connectors')!, 'connectors', ['reject', 'detach', 'delete'] as const) } : {}), ...(named('subtree') ? { subtree: this.bool(named('subtree')!, 'subtree') } : {}) });
          this.forget(id);
          break;
        }
        case 'duplicate': {
          const src = this.target(c.positional[0] ?? this.error('duplicate needs a target'));
          const as = named('as');
          this.unknownKeys(c, ['as', 'dx', 'dy']);
          const newId = this.ctx.newUuid();
          if (as) this.defineAlias(this.text(as), newId, this.known.get(src)?.kind ?? 'shape', as);
          this.emit({ op: 'duplicate', targets: [src], ids: { [src]: newId }, ...(as ? { aliases: { [src]: this.text(as) } } : {}),
            offset: { xPt: named('dx') ? this.dim(named('dx')!, 'dx') : 0, yPt: named('dy') ? this.dim(named('dy')!, 'dy') : 0 } });
          break;
        }
        case 'align': {
          const [edgeTok, ...rest] = c.positional;
          if (!edgeTok) this.error('align needs an edge');
          const edgeWord = this.text(edgeTok);
          const edge = ({ hcenter: 'center', vcenter: 'middle' } as Record<string, string>)[edgeWord] ?? edgeWord;
          if (!['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(edge)) this.error(`unknown alignment "${edgeWord}"`, edgeTok);
          this.emit({ op: 'align', targets: this.targets(rest), edge: edge as any });
          break;
        }
        case 'distribute': {
          const [axis, ...rest] = c.positional;
          this.emit({ op: 'distribute', axis: this.oneOf(axis ?? this.error('distribute needs an axis'), 'axis', ['horizontal', 'vertical'] as const), targets: this.targets(rest) });
          break;
        }
        case 'set-gap': {
          const [axis, ...rest] = c.positional;
          const gap = rest.pop();
          if (!gap) this.error('set-gap needs targets and a distance');
          this.emit({ op: 'setGap', axis: this.oneOf(axis ?? this.error('set-gap needs an axis'), 'axis', ['horizontal', 'vertical'] as const), targets: this.targets(rest), gapPt: this.dim(gap, 'gap') });
          break;
        }
        case 'z': {
          const [action, ...rest] = c.positional;
          this.emit({ op: 'zorder', action: this.oneOf(action ?? this.error('z needs front|back|forward|backward'), 'z', ['front', 'back', 'forward', 'backward'] as const), targets: this.targets(rest) });
          break;
        }
        case 'layer add': {
          this.unknownKeys(c, ['name', 'visible', 'locked', 'printable']);
          const layer: any = { id: this.ctx.newUuid() };
          if (named('name')) layer.name = this.text(named('name')!);
          for (const k of ['visible', 'locked', 'printable']) if (named(k)) layer[k] = this.bool(named(k)!, k);
          this.emit({ op: 'addLayer', pageId: this.page, layer });
          break;
        }
        case 'layer set': {
          const ref = c.positional[0] ?? this.error('layer set needs a layer name');
          this.unknownKeys(c, ['name', 'visible', 'locked', 'printable']);
          const patch: any = {};
          if (named('name')) patch.name = this.text(named('name')!);
          for (const k of ['visible', 'locked', 'printable']) if (named(k)) patch[k] = this.bool(named(k)!, k);
          this.emit({ op: 'setLayer', pageId: this.page, layer: this.text(ref), patch });
          break;
        }
        case 'layer assign': {
          const [ref, ...rest] = c.positional;
          if (!ref) this.error('layer assign needs a layer name and targets');
          this.unknownKeys(c, ['mode']);
          this.emit({ op: 'assignLayer', layers: [this.text(ref)], targets: this.targets(rest), ...(named('mode') ? { mode: this.oneOf(named('mode')!, 'mode', ['set', 'add', 'remove'] as const) } : {}) });
          break;
        }
        case 'asset import': {
          const key = named('ref') ?? named('name') ?? c.positional[0];
          if (!key) this.error('asset import needs ref=<prepared asset name>');
          const ref = this.ctx.preparedAssetRefs?.[this.text(key)];
          if (!ref) this.error(`no prepared asset "${this.text(key)}"; the host must prepare approved files before the script runs`, key);
          this.emit({ op: 'registerAsset', asset: ref.asset });
          break;
        }
        case 'asset replace': {
          if (c.positional[0] && this.text(c.positional[0]) === 'global') {
            if (!named('from') || !named('to')) this.error('asset replace global needs from= and to=');
            this.emit({ op: 'replaceAssetGlobal', fromAssetId: this.text(named('from')!), toAssetId: this.text(named('to')!) });
          } else {
            const id = this.target(c.positional[0] ?? this.error('asset replace needs an image target'));
            if (!named('asset')) this.error('asset replace needs asset=');
            this.emit({ op: 'set', target: id, patch: { assetId: this.text(named('asset')!) } });
          }
          break;
        }
        default:
          this.error(`unknown command "${verb}"`);
      }
    }
  }

  private unknownKeys(c: ScriptCommand, allowed: string[]) {
    for (const [k, v] of c.named) if (!allowed.includes(k)) this.error(`unknown field ${k}= for ${c.verb.join(' ')}`, (v as any).keySpan ?? v.span);
  }
}

export function compile(source: string, context: CompileContext): Result<CompiledScript> {
  try {
    const compiler = new Compiler(context);
    compiler.compile(parse(source));
    if (compiler.ops.length === 0) return err('invalid_request', 'script contains no commands', { line: 1, column: 1 });
    return ok({ operations: compiler.ops, spans: compiler.spans });
  } catch (e) {
    if (e instanceof PlanError) return err(e.code, e.message, e.details, 'not_applied');
    return err('internal_error', String(e));
  }
}

/** Validate: compile and plan against the captured revision without committing anything. */
export function validateScript(source: string, context: CompileContext): Result<CompiledScript & { created: string[]; changed: string[]; deleted: string[] }> {
  const compiled = compile(source, context);
  if (!compiled.ok) return compiled;
  const planned = planOperations(context.snapshot.document, compiled.value.operations, { newUuid: context.newUuid });
  if (!planned.ok) {
    const i = planned.error.details?.operationIndex as number | undefined;
    const span = i !== undefined ? compiled.value.spans[i] : undefined;
    return span ? { ok: false, error: { ...planned.error, message: `line ${span.line}: ${planned.error.message}`, details: { ...planned.error.details, line: span.line, column: span.column } } } : planned;
  }
  const created: string[] = [], changed: string[] = [], deleted: string[] = [];
  for (const c of planned.value.changes) if (c.entity === 'element') (c.before === null ? created : c.after === null ? deleted : changed).push(c.id);
  return ok({ ...compiled.value, created, changed, deleted });
}
