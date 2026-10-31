#!/usr/bin/env python3
"""
Transform the single-file LMS app JS into multi-page modules with:
  * no inline event handlers  -> data-act / data-* consumed by a delegated dispatcher
  * no inline style attrs     -> curated utility / state classes
Fails loudly if anything is left unmapped.
"""
import re, os, sys, json, collections

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT  = os.path.join(ROOT, "app", "assets", "js")
candidate_paths = [
    os.environ.get('LMS_SOURCE'),
    os.path.join(ROOT, "LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html"),
    os.path.join(ROOT, "requirments", "LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html")
]
SRC = next((p for p in candidate_paths if p and os.path.exists(p)), candidate_paths[1])

# The application code is the LAST <script> block of the single-file build.
# (The first one holds the bundled libraries; extract_vendor.py handles that.)
html = open(SRC, encoding='utf-8').read()
_i = html.rindex('<script>')
_j = html.index('</script>', _i)
src = html[_i + len('<script>'):_j]
if len(src.split('\n')) != 2580:
    sys.exit("app script is %d lines, expected 2580 — the line-based split below "
             "would be wrong. Re-check the source file." % len(src.split('\n')))

report = collections.Counter()

# =====================================================================
# 0. EXPLICIT replacements for handlers the generic parser can't parse
#    (they contain quotes or regex literals inside ${ })
# =====================================================================
EXPLICIT = {}

# landowners view: "Start succession mutation" — embeds a JSON array via .replace(/"/g,"'")
EXPLICIT[
  """onclick="closeModal('view');openForm('mutations',null,{deceasedId:'${r.id}',surveyIds:${JSON.stringify((r.shares || []).map(s => s.surveyId)).replace(/"/g, "'")},province:'${jsq(r.province)}'})\""""
] = (
  """data-act="openForm" data-close="view" data-a1="mutations" data-a2="" """
  """data-aj="${esc(JSON.stringify({ deceasedId: r.id, surveyIds: (r.shares || []).map(s => s.surveyId), province: r.province }))}\""""
)

# landowners view: "New case"
EXPLICIT[
  """onclick="closeModal('view');openForm('cases',null,{owners:[{landownerId:'${r.id}',status:'${jsq(r.ownerType)}',share:100}]})\""""
] = (
  """data-act="openForm" data-close="view" data-a1="cases" data-a2="" """
  """data-aj="${esc(JSON.stringify({ owners: [{ landownerId: r.id, status: r.ownerType, share: 100 }] }))}\""""
)

# rows view: "Log violation"
EXPLICIT[
  """onclick="closeModal('view');openForm('encroachments',null,{category:'ROW Violation / Conflict',rowId:'${r.id}',projectId:'${jsq(r.projectId)}',province:'${jsq(r.province)}'})\""""
] = (
  """data-act="openForm" data-close="view" data-a1="encroachments" data-a2="" """
  """data-aj="${esc(JSON.stringify({ category: 'ROW Violation / Conflict', rowId: r.id, projectId: r.projectId, province: r.province }))}\""""
)

# audit screen: inline Excel export of the whole trail -> named function
EXPLICIT[
  """onclick="exportXLSX('Audit trail',['When','User','Role','Module','Record','Action','Note','Changes'],S.audit.map(a=>[a.at,a.user,a.role,a.coll,a.code,a.action,a.note,(a.changes||[]).map(c=>c.f+': '+JSON.stringify(c.from??'')+' -> '+JSON.stringify(c.to??'')).join(' | ')]))\""""
] = """data-act="auditExport\""""

# list search box (debounced) -> named action
EXPLICIT[
  """oninput="UI.q['${c}']=this.value;UI.page&&(UI.page['${c}']=0);clearTimeout(window._qt);window._qt=setTimeout(()=>{render();const s=document.querySelector('.search');s.focus();s.setSelectionRange(s.value.length,s.value.length)},250)\""""
] = """data-act="listSearch" data-a1="${esc(c)}\""""

# report-builder collection picker (multi-assignment)
EXPLICIT[
  """onchange="UI.rb={coll:this.value,cols:null,q:'',st:'',from:'',to:'',gb:'',name:''};render()\""""
] = """data-act="rbColl\""""

# dropzone drag & drop -> bound by attachDropzone(), no inline handlers
EXPLICIT["""ondragover="event.preventDefault();this.classList.add('over')\""""] = """data-dropzone="1\""""
EXPLICIT["""ondragleave="this.classList.remove('over')\""""] = ""
EXPLICIT[
  """ondrop="event.preventDefault();this.classList.remove('over');attachFiles('${c}','${id}',event.dataTransfer.files)\""""
] = """data-drop-coll="${esc(c)}" data-drop-id="${esc(id)}\""""

# map search on Enter
EXPLICIT["""onkeydown="if(event.key==='Enter')mapSearch()\""""] = """data-enter="mapSearch\""""

# sub-table row delete
EXPLICIT["""onclick="this.closest('tr').remove();formCompute()\""""] = """data-act="subRowDelete\""""

# UI state setters that read the control's own value
UI_SETTERS = {
  """onchange="UI.stage['${c}']=this.value;render()\"""":
      """data-act="setStage" data-a1="${esc(c)}\"""",
  """onchange="UI.rf.${k}=this.value;render()\"""":
      """data-act="setReportFilter" data-a1="${esc(k)}\"""",
  """onchange="UI.af=Object.assign(UI.af||{},{m:this.value});render()\"""":
      """data-act="setAuditFilter" data-a1="m\"""",
  """onchange="UI.af=Object.assign(UI.af||{},{u:this.value});render()\"""":
      """data-act="setAuditFilter" data-a1="u\"""",
  """onchange="UI.af=Object.assign(UI.af||{},{q:this.value});render()\"""":
      """data-act="setAuditFilter" data-a1="q\"""",
  """onchange="UI.df=Object.assign(UI.df||{},{q:this.value});render()\"""":
      """data-act="setDocFilter" data-a1="q\"""",
  """onchange="UI.df=Object.assign(UI.df||{},{cat:this.value});render()\"""":
      """data-act="setDocFilter" data-a1="cat\"""",
  """onchange="UI.df=Object.assign(UI.df||{},{del:this.checked});render()\"""":
      """data-act="setDocFilter" data-a1="del" data-src="checked\"""",
  """onchange="UI.pd=this.value;render()\"""":
      """data-act="setProjectPick\"""",
  """onchange="UI.rb.st=this.value;render()\"""":
      """data-act="setRbFilter" data-a1="st\"""",
  """onchange="UI.rb.q=this.value;render()\"""":
      """data-act="setRbFilter" data-a1="q\"""",
  """onchange="UI.rb.gb=this.value;render()\"""":
      """data-act="setRbFilter" data-a1="gb\"""",
  """onchange="UI.rb.from=this.value;render()\"""":
      """data-act="setRbFilter" data-a1="from\"""",
  """onchange="UI.rb.to=this.value;render()\"""":
      """data-act="setRbFilter" data-a1="to\"""",
  """onchange="UI.impColl=this.value;IMPST=null;render()\"""":
      """data-act="setImportColl\"""",
  """onchange="rbCol('${esc(c.l)}',this.checked)\"""":
      """data-act="rbCol" data-a1="${esc(c.l)}" data-src="checked\"""",
  """onchange="attachFiles('${c}','${id}',this.files)\"""":
      """data-act="attachPick" data-a1="${esc(c)}" data-a2="${esc(id)}\"""",
  """onchange="restoreJSON(this.files[0])\"""":
      """data-act="restorePick\"""",
  """onchange="gisUpload(this.files[0]);this.value=''\"""":
      """data-act="gisPick\"""",
  # record-view tab strip
  """onclick="VIEW.tab='${k}';drawView()\"""":
      """data-act="setViewTab" data-a1="${esc(k)}\"""",
  # pagination
  """onclick="UI.page['${c}']=${pgn - 1};render()\"""":
      """data-act="setPage" data-a1="${esc(c)}" data-a2="${pgn - 1}\"""",
  """onclick="UI.page['${c}']=${pgn + 1};render()\"""":
      """data-act="setPage" data-a1="${esc(c)}" data-a2="${pgn + 1}\"""",
  # calendar month navigation
  """onclick="UI.calM=new Date(${y},${m - 1},1).toISOString();render()\"""":
      """data-act="setCalMonth" data-a1="${y}" data-a2="${m - 1}\"""",
  """onclick="UI.calM=null;render()\"""":
      """data-act="setCalMonth\"""",
  """onclick="UI.calM=new Date(${y},${m + 1},1).toISOString();render()\"""":
      """data-act="setCalMonth" data-a1="${y}" data-a2="${m + 1}\"""",
  # report picker
  """onclick="UI.reportId='rb';UI._rbLoaded=null;render()\"""":
      """data-act="pickReport" data-a1="rb\"""",
  """onclick="UI.reportId='sv_${x.id}';UI._rbLoaded=null;render()\"""":
      """data-act="pickReport" data-a1="sv_${esc(x.id)}\"""",
  """onclick="UI.reportId='${r.id}';UI.rf={};render()\"""":
      """data-act="pickReport" data-a1="${esc(r.id)}\"""",
  """onclick="IMPST=null;render()\"""":
      """data-act="resetImport\"""",
  """onclick="window.print()\"""":
      """data-act="printPage\"""",
  """onclick="event.stopPropagation();remind('${e.c}','${e.id}')\"""":
      """data-act="remind" data-stop="1" data-a1="${esc(e.c)}" data-a2="${esc(e.id)}\"""",
}
EXPLICIT.update(UI_SETTERS)

# ---- cross-page navigation: become real links where the element is an <a>,
#      otherwise a data-nav the dispatcher follows.
NAV = {
  """onclick="UI.impColl='${c}';go('import')\"""":
      """data-act="navigate" data-href="${pageUrl('import')}?coll=${esc(c)}\"""",
  """onclick="closeModal('view');UI.mapFocus={lat:${num(r.lat)},lng:${num(r.lng)}};go('gis');return false\"""":
      """data-act="navigate" data-href="${pageUrl('gis')}?lat=${num(r.lat)}&lng=${num(r.lng)}\"""",
  """onclick="closeModal('view');UI.mapFocus={lat:${r.lat},lng:${r.lng},id:'${r.id}'};go('gis')\"""":
      """data-act="navigate" data-href="${pageUrl('gis')}?lat=${num(r.lat)}&lng=${num(r.lng)}&id=${esc(r.id)}\"""",
  """onclick="UI.mapFocus={lat:${num(p.lat)},lng:${num(p.lng)}};go('gis')\"""":
      """data-act="navigate" data-href="${pageUrl('gis')}?lat=${num(p.lat)}&lng=${num(p.lng)}\"""",
  """onclick="closeModal('view');UI.reportId='r9';UI.rf={project:'${r.id}'};go('reports')\"""":
      """data-act="navigate" data-href="${pageUrl('reports')}?report=r9&project=${esc(r.id)}\"""",
  """onclick="UI.reportId='r9';UI.rf={project:'${p.id}'};go('reports')\"""":
      """data-act="navigate" data-href="${pageUrl('reports')}?report=r9&project=${esc(p.id)}\"""",
  """onclick="go('${go_}')\"""":
      """data-act="navigate" data-href="${pageUrl(go_)}\"""",
  """onclick="go('audit')\"""":
      """data-act="navigate" data-href="${pageUrl('audit')}\"""",
  """onclick="go('inbox')\"""":
      """data-act="navigate" data-href="${pageUrl('inbox')}\"""",
}
EXPLICIT.update(NAV)

for old, new in EXPLICIT.items():
    n = src.count(old)
    if n == 0:
        sys.exit("EXPLICIT pattern not found:\n  " + old[:160])
    src = src.replace(old, new)
    report['handlers'] += n

# =====================================================================
# 1. GENERIC parser: a handler that is one plain call
# =====================================================================
def split_args(s):
    """split a JS argument list at top-level commas"""
    out, depth, cur, i = [], 0, '', 0
    quote = None
    while i < len(s):
        ch = s[i]
        if quote:
            cur += ch
            if ch == quote and s[i-1] != '\\':
                quote = None
        elif ch in '"\'':
            quote = ch; cur += ch
        elif ch in '([{':
            depth += 1; cur += ch
        elif ch in ')]}':
            depth -= 1; cur += ch
        elif ch == ',' and depth == 0:
            out.append(cur.strip()); cur = ''
        else:
            cur += ch
        i += 1
    if cur.strip():
        out.append(cur.strip())
    return out

def arg_to_attr(a):
    """turn a JS call argument into (attribute value, is_numeric)"""
    a = a.strip().replace('jsq(', 'esc(')
    m = re.fullmatch(r"'(.*)'", a, re.S)
    if m:                                   # quoted literal, may hold ${ }
        return m.group(1), False
    if a == 'null':
        return '', False
    if re.fullmatch(r'\$\{.*\}', a, re.S):  # bare template expression
        inner = a[2:-1]
        if inner.startswith('num('):
            return a, True
        return '${esc(%s)}' % inner, False
    if re.fullmatch(r'-?[\d.]+', a):        # numeric literal
        return a, True
    return '${esc(%s)}' % a, False

HANDLER_RE = re.compile(r'\bon(?:click|change|submit)="([^"]*)"')

def convert(m):
    h = m.group(1).strip()
    pre = ''
    if h.endswith(';return false'):
        h = h[:-len(';return false')].strip()
    if h.startswith('event.stopPropagation();'):
        pre += ' data-stop="1"'
        h = h[len('event.stopPropagation();'):].strip()
    mc = re.match(r"^closeModal\('(\w+)'\);(.*)$", h, re.S)
    if mc:
        pre += ' data-close="%s"' % mc.group(1)
        h = mc.group(2).strip()
    h = h.rstrip(';')
    call = re.fullmatch(r'([A-Za-z_$][\w$]*)\((.*)\)', h, re.S)
    if not call:
        return None
    fn, argstr = call.group(1), call.group(2)
    attrs = ' data-act="%s"%s' % (fn, pre)
    nums = []
    for i, a in enumerate(split_args(argstr), 1):
        val, isnum = arg_to_attr(a)
        attrs += ' data-a%d="%s"' % (i, val)
        if isnum:
            nums.append(str(i))
    if nums:                      # tell the dispatcher which args to coerce
        attrs += ' data-num="%s"' % ','.join(nums)
    report['handlers'] += 1
    report[('fn', fn)] += 1
    return attrs.strip()

def sub_handlers(text):
    out, pos = [], 0
    for m in HANDLER_RE.finditer(text):
        rep = convert(m)
        if rep is None:
            continue
        out.append(text[pos:m.start()]); out.append(rep); pos = m.end()
    out.append(text[pos:])
    return ''.join(out)

src = sub_handlers(src)

left = re.findall(r'\bon[a-z]+="[^"]*"', src)
if left:
    sys.exit("UNCONVERTED handlers (%d):\n  %s" % (len(left), '\n  '.join(left[:10])))

# =====================================================================
# 2. style="" -> classes
# =====================================================================
APP_STYLES = {
 'margin:14px 0 4px':'u-vh', 'margin-top:10px':'u-mt-10', 'color:var(--accent)':'u-accent',
 'text-align:left':'u-ta-left', 'margin:0':'u-m-0', 'margin-top:8px':'u-mt-8',
 'margin-top:12px':'u-mt-12', 'margin:12px 0 6px;font-size:12.5px':'u-subhead',
 'color:var(--danger)':'u-danger', 'flex-direction:column;align-items:stretch':'u-stack',
 'flex:1':'u-flex-1', 'font-size:11.5px':'u-fs-115', 'margin-bottom:8px':'u-mb-8',
 'margin:12px 0 4px':'u-subhead-2', 'max-height:340px':'u-mh-340', 'max-height:none':'u-mh-none',
 'white-space:nowrap':'u-nowrap',
 'background:#7a4fc2;border-radius:2px;height:4px':'lgd-bar u-bg-row',
 'background:#d93a3a':'u-bg-danger', 'color:#cfe0f5':'u-link-on-dark',
 'cursor:default;background:#FFF4E5;border-color:#F0B35A;color:#8A5A00;font-weight:600':'is-static',
 'cursor:pointer':'u-clickable', 'display:flex;gap:6px':'u-row-6',
 'font-size:11.5px;text-align:left':'u-fs-115 u-ta-left', 'font-size:11px':'u-fs-11',
 'font-size:12.5px':'u-fs-125', 'font-weight:400':'u-fw-400',
 'font-weight:400;opacity:.85':'u-fw-400 u-dim', 'grid-column:span 2':'u-col-span-2',
 'grid-template-columns:1fr 330px':'u-split-330',
 'grid-template-columns:1fr;margin-top:10px':'u-cols-1 u-mt-10',
 'grid-template-columns:repeat(3,1fr)':'u-cols-3',
 'grid-template-columns:repeat(4,1fr)':'u-cols-4',
 'grid-template-columns:repeat(4,1fr);margin-bottom:10px':'u-cols-4 u-mb-10',
 'justify-content:center':'u-jc-center', 'margin-bottom:10px':'u-mb-10',
 'margin-bottom:6px':'u-mb-6', 'margin-top:14px':'u-mt-14', 'margin-top:16px':'u-mt-16',
 'margin-top:16px;font-size:12px':'u-mt-16 u-fs-12', 'margin-top:6px':'u-mt-6',
 'margin:10px 0 0;justify-content:flex-end':'u-pager', 'margin:14px 0 8px':'u-sec-head',
 'margin:5px 0;border:0;border-top:1px solid #ddd':'u-hr',
 'max-height:260px':'u-mh-260', 'max-height:300px':'u-mh-300', 'max-height:330px':'u-mh-330',
 'max-width:380px':'u-mw-380', 'min-width:380px':'u-minw-380',
 'padding-left:18px;line-height:1.8':'u-list', 'white-space:normal;min-width:84px':'u-wrap-84',
 'width:100%;max-height:360px':'u-w-full u-mh-360', 'width:110px;text-align:right':'u-w-110 u-ta-right',
 'z-index:800':'',
}
PRINT_STYLES = {
 'border:0':'p-nb', 'border:0;text-align:right':'p-nb p-tr', 'text-align:center':'p-tc',
 'float:right':'p-fr', 'text-align:justify;line-height:1.6':'p-just',
 'margin-top:14px':'p-mt-14', 'margin-top:20px':'p-mt-20', 'margin-top:8px':'p-mt-8',
 'border:1px dashed #999;padding:14px 20px;margin-left:30px':'p-stamp',
 'font-size:15px':'p-fs-15', 'height:38px':'p-h-38', 'line-height:1.6':'p-lh-16',
 'line-height:1.7;text-align:justify':'p-just-17', 'text-align:justify;line-height:1.7':'p-just-17',
 'margin-top:14px;font-size:13px':'p-mt-14 p-fs-13',
 'margin-top:30px':'p-mt-30', 'margin-top:40px':'p-mt-40',
 'position:fixed;top:40%;left:10%;font-size:70px;color:rgba(200,0,0,.12);transform:rotate(-25deg);font-weight:bold':'p-watermark',
 'width:70%;margin-right:20px':'p-w-70', 'width:80%;margin-left:20px':'p-w-80',
}
# dynamic style attrs -> (extra classes, extra attributes)
# A colour that varies per record becomes a CSS custom property that
# applyDynamic() assigns at render time — never an inline style attribute.
DYNAMIC = {
 "background:${p.grad}": (None, """data-bg="${esc(p.grad)}\""""),
 "background:${p ? p.color : '#888'}": (None, """data-bg="${esc(p ? p.color : '#888')}\""""),
 "background:${c}": (None, """data-bg="${esc(c)}\""""),
 "border-left-color:${e.col}": (None, """data-accent="${esc(e.col)}\""""),
 "border-left:4px solid ${e.col}": (None, """data-accent-full="${esc(e.col)}\""""),
 "border-left:4px solid ${c}": (None, """data-accent-full="${esc(c)}\""""),
 "color:${ST_COL[s.status]}": (None, """data-color="${esc(ST_COL[s.status] || '')}\""""),
 "${c.w ? 'min-width:' + c.w + 'px' : ''}": (None, """data-minw="${c.w ? c.w + 'px' : ''}\""""),
 "max-height:${compact ? '330px' : '64vh'}": ("${compact ? 'is-compact' : 'is-tall'}", None),
 "${['multiref', 'checks', 'textarea'].includes(f.t) ? 'grid-column:1/-1' : ''}":
     ("${['multiref', 'checks', 'textarea'].includes(f.t) ? 'is-wide' : ''}", None),
 "${d.deleted ? 'opacity:.55' : ''}": ("${d.deleted ? 'is-deleted' : ''}", None),
 "${v.includes(val) ? '' : 'opacity:.4;text-decoration:line-through'}":
     ("${v.includes(val) ? '' : 'is-off'}", None),
 "color:${b.balance < 0 ? 'var(--danger)' : 'inherit'}":
     ("${b.balance < 0 ? 'is-bad' : ''}", None),
 "color:${bad ? 'var(--danger)' : 'inherit'}": ("${bad ? 'is-bad' : ''}", None),
 "color:${Math.abs(shareT - 100) < .5 || !(r.owners || []).length ? 'inherit' : 'var(--danger)'}":
     ("${Math.abs(shareT - 100) < .5 || !(r.owners || []).length ? '' : 'is-bad'}", None),
 "color:${Math.abs(sum(r.heirs || [], 'share') - 100) < .01 ? 'inherit' : 'var(--danger)'}":
     ("${Math.abs(sum(r.heirs || [], 'share') - 100) < .01 ? '' : 'is-bad'}", None),
}

PRINT_RANGES = [(522, 549), (1697, 1751), (1964, 1988)]

def tag_bounds(text, pos):
    """locate the '<' and '>' of the tag containing offset pos"""
    i = text.rfind('<', 0, pos)
    while i > 0 and not re.match(r'<[a-zA-Z/]', text[i:i+2]):
        i = text.rfind('<', 0, i)
    if i < 0:
        return None
    j, depth = pos, 0
    while j < len(text):
        if text.startswith('${', j):
            depth += 1; j += 2; continue
        ch = text[j]
        if ch == '{' and depth: depth += 1
        elif ch == '}' and depth: depth -= 1
        elif ch == '>' and not depth: return i, j
        j += 1
    return None

def apply_styles(text, mapping, label):
    """remove each mapped style="", merging its classes into the tag's own
       class attribute (HTML honours only the first one) and appending any
       extra data-* attributes."""
    count = 0
    while True:
        hit = None
        for m in re.finditer(r'\sstyle="([^"]*)"', text):
            if m.group(1) in mapping:
                hit = m; break
        if not hit:
            break
        classes, attrs = mapping[hit.group(1)]
        b = tag_bounds(text, hit.start())
        if b is None:
            sys.exit("%s: cannot find tag for style %r" % (label, hit.group(1)))
        ts, te = b
        text = text[:hit.start()] + text[hit.end():]          # drop the style attr
        te -= (hit.end() - hit.start())
        tag = text[ts:te+1]
        if classes:
            cm = re.search(r'class="([^"]*)"', tag)
            if cm:                                            # merge, never duplicate
                tag = tag[:cm.start(1)] + (cm.group(1) + ' ' + classes).strip() + tag[cm.end(1):]
            else:
                sp = tag.find(' ')
                ins = len(tag) - 1 if sp < 0 else sp
                tag = tag[:ins] + ' class="%s"' % classes + tag[ins:]
        if attrs:
            ins = len(tag) - 1
            while ins > 0 and tag[ins-1] in '/ ':
                ins -= 1
            tag = tag[:ins] + ' ' + attrs + tag[ins:]
        text = text[:ts] + tag + text[te+1:]
        count += 1
    report[label] += count
    return text

APP_MAP   = {k: (v, None) for k, v in APP_STYLES.items()}
PRINT_MAP = {k: (v, None) for k, v in PRINT_STYLES.items()}

lines = src.split('\n')
def in_print(n): return any(a <= n <= b for a, b in PRINT_RANGES)
for idx in range(len(lines)):
    mapping = dict(PRINT_MAP if in_print(idx + 1) else APP_MAP)
    mapping.update(DYNAMIC)                                   # dynamic applies everywhere
    label = 'print-styles' if in_print(idx + 1) else 'app-styles'
    lines[idx] = apply_styles(lines[idx], mapping, label)
src = '\n'.join(lines)

leftover = [v for v in re.findall(r'\sstyle="([^"]*)"', src) if '${' not in v]
if leftover:
    sys.exit("UNMAPPED static styles (%d):\n  %s" % (len(leftover), '\n  '.join(sorted(set(leftover)))))
dynleft = [v for v in re.findall(r'\sstyle="([^"]*)"', src)]
if dynleft:
    sys.exit("REMAINING style attrs (%d):\n  %s" % (len(dynleft), '\n  '.join(sorted(set(dynleft))[:10])))

# =====================================================================
# 2b. CLICKABILITY — anything that represents a record or a destination
#     becomes a real <a href>. The data-act stays, so a plain click still
#     opens the modal in place; the href gives the thing a URL, keyboard
#     focus, a status-bar preview and middle-click / open-in-new-tab.
#     Replacements must stay on one line: the split below is line-based.
# =====================================================================
CLICKABLE = {
 # record code links inside a record view
 """const vlink = (c, r) => `<a href="#" data-act="openView" data-a1="${c}" data-a2="${r.id}" class="mono">${esc(r.code)}</a>`;""":
 """const vlink = (c, r) => `<a href="${pageUrl(c)}?view=${encodeURIComponent(r.id)}" data-act="openView" data-a1="${c}" data-a2="${r.id}" class="mono">${esc(r.code)}</a>`;""",

 # reference / multi-reference fields
 """case 'ref': return `<a href="#" data-act="openView" data-a1="${esc(f.coll)}" data-a2="${esc(v)}">${esc(lbl(f.coll, v))}</a>`;""":
 """case 'ref': return `<a href="${pageUrl(f.coll)}?view=${encodeURIComponent(v)}" data-act="openView" data-a1="${esc(f.coll)}" data-a2="${esc(v)}">${esc(lbl(f.coll, v))}</a>`;""",

 """case 'multiref': return v.map(id => `<a href="#" class="pill" data-act="openView" data-a1="${f.coll}" data-a2="${id}">${esc(codeOf(f.coll, id))}</a>`).join(' ');""":
 """case 'multiref': return v.map(id => `<a href="${pageUrl(f.coll)}?view=${encodeURIComponent(id)}" class="pill" data-act="openView" data-a1="${f.coll}" data-a2="${id}">${esc(codeOf(f.coll, id))}</a>`).join(' ');""",

 # a KPI tile that drills into a screen is a link, not a clickable box
 """function kpi(l, v, s, cls, go_) { return `<div class="kpi ${cls || ''}" ${go_ ? `data-act="navigate" data-href="${pageUrl(go_)}"` : ''}><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }""":
 """function kpi(l, v, s, cls, go_) { const t = go_ ? 'a' : 'div'; return `<${t} class="kpi ${cls || ''}"${go_ ? ` href="${pageUrl(go_)}"` : ''}><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></${t}>`; }""",

 # alerts (dashboard and project dashboard share this template)
 """<div class="al ${a.sev}" data-act="openView" data-a1="${a.c}" data-a2="${a.id}"><span class="i"></span><div class="tx"><b>${esc(a.t)}</b><small>${esc(a.s)}</small></div></div>""":
 """<a class="al ${a.sev}" href="${pageUrl(a.c)}?view=${encodeURIComponent(a.id)}" data-act="openView" data-a1="${a.c}" data-a2="${a.id}"><span class="i"></span><div class="tx"><b>${esc(a.t)}</b><small>${esc(a.s)}</small></div></a>""",

 # notification entries
 """<div class="al i" data-act="openView" data-a1="${n.coll}" data-a2="${n.recId}"><span class="i"></span><div class="tx"><b>${esc(n.msg)}</b><small>${fdtt(n.at)} · ${esc(n.channel)}</small></div></div>""":
 """<a class="al i" href="${pageUrl(n.coll)}?view=${encodeURIComponent(n.recId)}" data-act="openView" data-a1="${n.coll}" data-a2="${n.recId}"><span class="i"></span><div class="tx"><b>${esc(n.msg)}</b><small>${fdtt(n.at)} · ${esc(n.channel)}</small></div></a>""",

 # list rows: the first cell is the link to the record
 """<tr>${sp.cols.map((col, i) => `<td class="${col.num ? 'num' : ''}" ${i === 0 ? `data-act="openView" data-a1="${c}" data-a2="${r.id}"` : ''}>${col.v(r)}</td>`).join('')}""":
 """<tr class="is-link">${sp.cols.map((col, i) => `<td class="${col.num ? 'num' : ''}">${i === 0 ? `<a class="cell-link" href="${pageUrl(c)}?view=${encodeURIComponent(r.id)}" data-act="openView" data-a1="${c}" data-a2="${r.id}">${col.v(r)}</a>` : col.v(r)}</td>`).join('')}""",

 # and the row's View button
 """<td><div class="acts"><button title="View" data-act="openView" data-a1="${c}" data-a2="${r.id}">\U0001F441</button>""":
 """<td><div class="acts"><a title="View ${esc(sp.title)}" href="${pageUrl(c)}?view=${encodeURIComponent(r.id)}" data-act="openView" data-a1="${c}" data-a2="${r.id}">\U0001F441</a>""",
}
# every remaining href="#" placeholder gets a real destination, and the one
# anchor that performs an action rather than navigating becomes a button
CLICKABLE.update({
 '<a href="#" data-act="openView" data-a1="projects" data-a2="${pj.id}">':
 """<a href="${pageUrl('projects')}?view=${encodeURIComponent(pj.id)}" data-act="openView" data-a1="projects" data-a2="${pj.id}">""",

 '<a href="#" data-act="openView" data-a1="rows" data-a2="${r.id}">':
 """<a href="${pageUrl('rows')}?view=${encodeURIComponent(r.id)}" data-act="openView" data-a1="rows" data-a2="${r.id}">""",

 '<a href="#" data-act="openView" data-a1="encroachments" data-a2="${e.id}">':
 """<a href="${pageUrl('encroachments')}?view=${encodeURIComponent(e.id)}" data-act="openView" data-a1="encroachments" data-a2="${e.id}">""",

 '<a href="#" data-act="openView" data-a1="surveys" data-a2="${s.id}">':
 """<a href="${pageUrl('surveys')}?view=${encodeURIComponent(s.id)}" data-act="openView" data-a1="surveys" data-a2="${s.id}">""",

 '<a href="#" class="mono" data-act="openView" data-a1="${a.coll}" data-a2="${a.recId}">':
 '<a href="${pageUrl(a.coll)}?view=${encodeURIComponent(a.recId)}" class="mono" data-act="openView" data-a1="${a.coll}" data-a2="${a.recId}">',

 '<a href="#" data-act="openView" data-a1="${d.coll}" data-a2="${d.recId}">':
 '<a href="${pageUrl(d.coll)}?view=${encodeURIComponent(d.recId)}" data-act="openView" data-a1="${d.coll}" data-a2="${d.recId}">',

 """<a href="#" data-act="navigate" data-href="${pageUrl('gis')}?lat=${num(r.lat)}&lng=${num(r.lng)}">""":
 """<a href="${pageUrl('gis')}?lat=${num(r.lat)}&amp;lng=${num(r.lng)}">""",

 # "Edit boundary" opens a dialog — that is a button, not a link
 '<a href="#" data-act="editBoundary" data-a1="${s.id}">Edit boundary</a>':
 '<button class="as-link" data-act="editBoundary" data-a1="${s.id}">Edit boundary</button>',

 # audit entries without a record code (a login, say) produced an anchor
 # with no text at all, which is unreadable and unusable with a screen reader
 '''data-a2="${a.recId}">${esc(a.code)}</a>''':
 '''data-a2="${a.recId}">${esc(a.code) || 'View record'}</a>''',

 # A read-only role used to see no "+ Add" button at all and no reason why.
 # Show it disabled with an explanation instead — a missing control teaches
 # nobody what their account can do. (One line: the split below is line-based.)
 """<div class="bar u-m-0">${can.create() && !(c === 'dbpfc' && CTX !== 'ALL' && CTX !== 'SND') ? `<button class="btn btn-p" data-act="openForm" data-a1="${c}">+ Add ${esc(sp.title)}</button>` : ''}${impOK ? `<button class="btn btn-g" data-act="navigate" data-href="${pageUrl('import')}?coll=${esc(c)}">\U0001F4E5 Upload Excel / CSV</button>` : ''}</div>""":
 """<div class="bar u-m-0">${!can.create() ? `<button class="btn btn-p" disabled title="Your role (${esc(ME.role)}) is read-only \\u2014 you can open and export records, but not add them.">+ Add ${esc(sp.title)}</button>` : (c === 'dbpfc' && CTX !== 'ALL' && CTX !== 'SND') ? `<button class="btn btn-p" disabled title="DBPFC applies to Sindh government land \\u2014 switch province to Sindh to add records.">+ Add ${esc(sp.title)}</button>` : `<button class="btn btn-p" data-act="openForm" data-a1="${c}">+ Add ${esc(sp.title)}</button>`}${impOK ? `<button class="btn btn-g" data-act="navigate" data-href="${pageUrl('import')}?coll=${esc(c)}">\U0001F4E5 Upload Excel / CSV</button>` : IMP[c] ? `<button class="btn btn-g" disabled title="Bulk upload needs data-entry rights.">\U0001F4E5 Upload Excel / CSV</button>` : ''}</div>""",

 # DATA SCOPE: screens that read the raw audit trail / document register
 # now read only what the signed-in account may see (app/scope.js).
 "let rows = S.audit.slice();": "let rows = visibleAudit();",
 "uniq(S.audit.map(a => a.coll))": "uniq(visibleAudit().map(a => a.coll))",
 "uniq(S.audit.map(a => a.user))": "uniq(visibleAudit().map(a => a.user))",
 "S.audit.filter(a => a.action !== 'Login' && a.action !== 'Logout')":
 "visibleAudit().filter(a => a.action !== 'Login' && a.action !== 'Logout')",
 "let docs = S.documents.filter(d => f.del ? true : !d.deleted);":
 "let docs = visibleDocs().filter(d => f.del ? true : !d.deleted);",
 # notifications: addressed to you AND about a record you may see
 "S.notifications.filter(n => n.to === ME.username)":
 "S.notifications.filter(n => n.to === ME.username && noteVisible(n))",
 # the outbox panel listed every notification sent to anyone, anywhere
 "const all = S.notifications.slice(0, 40);":
 "const all = S.notifications.filter(noteVisible).slice(0, 40);",
 # repeating rows in a record's details (e.g. a landowner's holdings) that
 # point at a record outside the viewer's access are left out of the display
 # — display only: the edit form keeps every row, so nothing is lost on save
 "</tr></thead><tbody>${v.map(row => `<tr>${f.cols.filter(c => c":
 "</tr></thead><tbody>${v.filter(row => subRowVisible(f, row)).map(row => `<tr>${f.cols.filter(c => c",
 # the Holdings panel: in-scope holdings, plus a count of the others
 """landowners: r => `<h4 class="u-vh">Holdings</h4>${miniTable(['Survey', 'Location', 'Share %', 'Survey total', 'Ref'], (r.shares || []).map(s => {""":
 """landowners: r => `<h4 class="u-vh">Holdings</h4>${hiddenNote(r.shares, 'surveys', 'surveyId', 'holding')}${miniTable(['Survey', 'Location', 'Share %', 'Survey total', 'Ref'], (r.shares || []).filter(s => refVisible('surveys', s.surveyId)).map(s => {""",
 # an audit entry links to its record only if this role can open that screen
 # (a non-admin's own sign-in used to link to the admin-only Users screen)
 "td>${a.recId && byId(a.coll, a.recId) ? `<a href=\"${pageUrl(a.col":
 "td>${a.recId && byId(a.coll, a.recId) && screenAllowed(a.coll) ? `<a href=\"${pageUrl(a.col",
 # the cross-tab "live update" notice must not reveal another area's activity
 "const who = S.audit[0];": "const who = visibleAudit()[0];",

 # Architecture screen: the multi-page build is not "a single HTML file"
 "['Hosting', 'Single HTML file',": "['Hosting', 'Static HTML / CSS / JS pages run in the browser (no server)',",
 "The demo runs as a single offline file;": "The demo runs as static pages in the browser, with no server or database;",

 # the Urdu passages are styled by print-form.css now
 'const UR_STYLE = `<style>.ur{direction:rtl;text-align:right;font-family:"Jameel Noori Nastaleeq","Noto Nastaliq Urdu","Urdu Typesetting","Noto Naskh Arabic","Segoe UI",serif;font-size:16px;line-height:2.1}</style>`;':
 "const UR_STYLE = ''; /* .ur is defined in assets/css/print-form.css */",
})

for old, new in CLICKABLE.items():
    n = src.count(old)
    if n == 0:
        sys.exit("CLICKABLE pattern not found:\n  " + old[:150])
    if old.count('\n') != new.count('\n'):
        sys.exit("CLICKABLE replacement changes the line count:\n  " + old[:80])
    src = src.replace(old, new)
    report['clickable'] += n

# ---- print documents: link the stylesheet instead of embedding a <style>
#      block, which a style-src CSP forbids. The replacement keeps the same
#      number of lines because the module split below is line-based.
PRINT_OLD = '''  d.open(); d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  body{font-family:"Times New Roman",serif;color:#111;margin:18mm 14mm;font-size:12px}h1,h2,h3{margin:0}h2{font-size:16px;text-align:center}h3{font-size:13px;text-align:center;margin:2px 0 10px}
  table{width:100%;border-collapse:collapse;margin:6px 0 4px}th,td{border:1px solid #444;padding:4px 6px;font-size:11px}th{background:#ddd}
  .band{background:#bbb;text-align:center;font-weight:bold;font-size:11px;padding:3px;margin-top:10px;letter-spacing:1px}
  .kv{display:grid;grid-template-columns:150px 1fr 170px 1fr;gap:3px 8px;margin:8px 0}.kv b{font-weight:normal}
  .r{text-align:right}.sig{display:grid;grid-template-columns:1fr 1fr;gap:28px 40px;margin-top:30px}.sig div{border-top:1px solid #000;padding-top:4px;font-size:11px}
  .small{font-size:10px;color:#444}.box{border:1px solid #000;padding:3px 8px;display:inline-block;font-weight:bold}.hdr{display:flex;justify-content:space-between;font-size:11px}
  @page{size:A4;margin:10mm}</style></head><body>${body}<p class="small p-mt-20">Generated by Land Management System (demo build ${APP_VER}) on ${fdtt(new Date())} · ${esc(ME.fullName)}</p></body></html>`);
  d.close(); setTimeout(() => { fr.contentWindow.focus(); fr.contentWindow.print(); setTimeout(() => fr.remove(), 4000); }, 300);'''

PRINT_NEW = '''  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8">`
    + `<title>${esc(title)}</title>`
    + `<link rel="stylesheet" href="${PRINT_CSS}">`
    + `</head><body>${body}`
    + `<p class="small p-mt-20">Generated by Land Management System (demo build ${APP_VER})`
    + ` on ${fdtt(new Date())} · ${esc(ME.fullName)}</p>`
    + `</body></html>`);
  d.close(); printWhenReady(fr, d);'''

if src.count(PRINT_OLD) != 1:
    sys.exit("printHTML body not found exactly once (%d)" % src.count(PRINT_OLD))
if PRINT_OLD.count('\n') != PRINT_NEW.count('\n'):
    sys.exit("printHTML replacement changes the line count")
src = src.replace(PRINT_OLD, PRINT_NEW)
report['clickable'] += 1

# =====================================================================
# 3. split into modules  (ranges are ORIGINAL app.js line numbers)
# =====================================================================
lines = src.split('\n')          # line count is preserved by the transforms
assert len(lines) == 2580, len(lines)

# The map screen was Leaflet. Its rendering and interaction now live in the
# hand-written app/gis-map.js (MapLibre GL); the Leaflet-only functions are
# dropped here rather than shipped as dead code. Data handling — KML / KMZ /
# GeoJSON parsing, upload, survey linking, saving boundaries and routes,
# the parcel popup — stays in ui/gis.js unchanged.
LEAFLET_ONLY = ['scrGIS', 'drawGIS', 'mapSearch', 'mapTool', 'mapClick', 'mapFinish',
                'editBoundary', 'pathLen', 'nearestSurvey']

def drop_functions(text, names):
    decl = re.compile(r'^(?:async\s+)?function\s+(\w+)\s*\(|^(?:const|let|var)\s+(\w+)|^/\*')
    out, skipping, dropped = [], False, set()
    for ln in text.split('\n'):
        m = decl.match(ln)
        if m:
            name = m.group(1) or m.group(2)
            skipping = name in names
            if skipping:
                dropped.add(name)
        if not skipping:
            out.append(ln)
    missing = set(names) - dropped
    if missing:
        sys.exit('expected to drop Leaflet functions not found: %s' % ', '.join(sorted(missing)))
    return '\n'.join(out)

HEADER = "/* %s\n   Part of the LMS multi-page build. Loaded as a classic script;\n   top-level declarations are shared across the bundle. */\n"
SEGMENTS = [
  ('core/engine.js',  'Core engine — utilities, state, provinces, units, roles, workflows, audit, form engine, exports', [(1, 549)]),
  ('core/calc.js',    'Derived calculations — case totals, lease info, areas, budgets',                                  [(550, 647)]),
  ('core/spec.js',    'Module specifications — fields, columns, workflows and validation per module',                    [(648, 1208)]),
  ('ui/screens.js',   'Screens — lists, record view, dashboard, inbox, audit, documents, settings, converter',           [(1209, 1226), (1276, 1696)]),
  ('ui/print.js',     'Print forms — compensation case, receipt, lease agreement, landowner statement',                  [(1697, 1751)]),
  ('ui/extras.js',    'Icons, user switch, approval matrix, notifications, calendar, project dashboard, Urdu prints',    [(1752, 2006)]),
  ('ui/gis.js',       'GIS data — parcel popup, boundary/route saving, KML/KMZ/GeoJSON import (map: app/gis-map.js)',                                  [(2007, 2192)]),
  ('ui/reports.js',   'Reports — standard reports and the custom report builder',                                        [(2193, 2291)]),
  ('ui/import.js',    'Data upload — Excel/CSV bulk import with validation and preview',                                 [(2292, 2393)]),
  ('data/demo.js',    'Demo data — illustrative only; all names, CNICs and figures are fictitious',                      [(2394, 2575)]),
]
for name, desc, ranges in SEGMENTS:
    body = '\n'.join('\n'.join(lines[a-1:b]) for a, b in ranges)
    if name == 'ui/gis.js':
        body = drop_functions(body, LEAFLET_ONLY)
    path = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(HEADER % desc + body.strip() + '\n')
    print("  %-20s %7d bytes" % (name, len(body)))

# =====================================================================
# 4. emit the action registry consumed by the dispatcher
# =====================================================================
# actions used by the page shell itself (topbar, modals, province cards)
EXTRA_ACTIONS = {
  'logout', 'showProvince', 'toggleTheme', 'switchUserDialog',
  'saveForm', 'useConverted', 'enterProvince', 'navigate', 'printPage',
  # the GL map screen (app/gis-map.js)
  'mapSearch', 'mapTool', 'editBoundary', 'gisBasemap', 'gisTheme', 'gisTerrain',
  'gisLayer', 'gisFly', 'gisFit', 'gisClear',
  # sample data generator (app/features.js)
  'openSampleDataModal', 'closeSampleDataModal', 'generateSampleDataAction',
  # features.js topbar & modal actions
  'toggleStickyDock', 'openFollowUps', 'openA11yModal', 'closeAppModal',
  'setA11yOpt', 'resetA11yOpts', 'openShortcutsModal', 'setStickyFilter',
  'openAddStickyNote', 'openAddStickyNoteRecord', 'saveNewStickyNote',
  'togglePinSticky', 'toggleStickyCheck', 'deleteStickyNote',
  'convertNoteToReminder', 'openEditStickyNote', 'openAddFollowUp',
  'openAddFollowUpDate', 'openAddFollowUpRecord', 'openFollowUpDetail',
  'saveNewFollowUp', 'completeFollowUp', 'reopenFollowUp', 'snoozeFollowUp',
  'deleteFollowUp', 'exportICal',
  # global search
  'openGlobalSearch', 'closeGlobalSearch', 'setSearchScope', 'selectSearchResult',
}
fns = sorted({k[1] for k in report if isinstance(k, tuple)} |
             {m for m in re.findall(r'data-act="(\w+)"', src)} |
             EXTRA_ACTIONS)
reg = (
  "/* Action registry — generated by the build from the data-act attributes\n"
  "   present in the markup. actions.js dispatches clicks and changes through\n"
  "   this table, so no handler is ever resolved from a string at runtime. */\n"
  "const ACTION_FNS = {\n" +
  ''.join("  %s,\n" % f for f in fns) + "};\n"
  "window.ACTION_FNS = ACTION_FNS;\n"
)
open(os.path.join(OUT, 'app/registry.js'), 'w', encoding='utf-8').write(reg)

print("\nactions:", report['handlers'], "| app styles:", report['app-styles'],
      "| print styles:", report['print-styles'], "| dynamic:", report['dyn-styles'])
print("registry (%d):" % len(fns), ', '.join(fns))
