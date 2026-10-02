# DrawScript

DrawScript is a line-based script that compiles into the same typed operations as
`apply_operations`. A whole script runs as one atomic transaction and undoes in one step. It has
no loops, no file or network access and no expression evaluation. Implementation:
`src/web/src/script/{lexer,parser,compiler}.ts`.

## Lexical rules

- UTF-8, one command per physical line; at most 1 MiB and 1,000 compiled operations.
- `#` starts a comment outside quotes. **Quote colours** (`fill="#FF0000"`), because an unquoted
  `#` starts a comment.
- Strings use double quotes with JSON escapes (`"say \"hi\"\n"`).
- Targets are page-scoped aliases (`[A-Za-z_][A-Za-z0-9_.-]*`), quoted UUIDs, or an exact display
  name. An ambiguous name is an error that lists its candidates.
- Dimensions need units: `pt`, `mm`, `cm`, `in`, `px` (px = 1/96 in). Angles are degrees, with an
  optional `deg` suffix. Booleans are `true`/`false`. Colours are `#RRGGBB`, `#RRGGBBAA` or `none`.
- Errors give the line and column, and never change the document.

## Commands

| Command | Example |
|---|---|
| `page use` (compile context only) | `page use "Architecture"` |
| `page add` / `rename` / `size` | `page add name="Two"` · `page rename "Main"` · `page size preset="A4 portrait"` · `page size w=200mm h=100mm` |
| `add shape` | `add shape id=a type=roundedRect x=10mm y=10mm w=40mm h=15mm text="A" fill="#FFFFFF"` |
| `add text` | `add text id=t x=10mm y=40mm w=60mm h=8mm text="Note"` |
| `add image` | `add image id=logo asset="asset:corona-energy-logo" x=25mm y=125mm w=45mm h=20mm fit=contain` |
| `connect` | `connect id=ab from=a.south to=b.north route=orthogonal endArrow=triangle label="flows"` |
| `group` / `ungroup` | `group id=g a b` · `ungroup g` |
| `set` (patch) | `set a stroke="#333333"` changes only the stroke |
| `move` | `move a x=10mm y=20mm` or `move a dx=3mm dy=0mm` (forms cannot mix) |
| `resize` | `resize a w=50mm h=20mm` |
| `rotate` | `rotate a angle=33` (absolute) · `rotate a by=15` · `rotate g by=30deg pivotX=50mm pivotY=40mm` (groups: `by=` only) |
| `delete` | `delete a connectors=detach` · `delete g subtree=true` |
| `duplicate` | `duplicate a as=a2 dx=5mm dy=0mm` |
| `align` | `align left\|center\|hcenter\|right\|top\|middle\|bottom a b c` |
| `distribute` | `distribute horizontal a b c` |
| `set-gap` | `set-gap vertical a b 20mm` |
| `z` | `z front\|back\|forward\|backward a` |
| `layer add` / `set` / `assign` | `layer add name="Notes"` · `layer set "Notes" visible=false` · `layer assign "Notes" a b` |
| `asset import` | `asset import ref=brand` (host-prepared approved file; never a path) |
| `asset replace` | `asset replace logo asset="asset:logo-v2"` (one image) · `asset replace global from="asset:a" to="asset:b"` |

`set` and `add` fields: `fill stroke strokeWidth fillOpacity dash text font fontSize bold italic
underline color align valign wrap padding x y w h rotation name alias locked hidden type radius`
(shapes and text), `asset fit opacity` (images), `route label startArrow endArrow` (connectors).

Endpoint `a.b.c` first tries the whole token as an alias, then splits off the last-dot port. For a
dotted alias with a port, write `from="a.b" fromPort=north`.
