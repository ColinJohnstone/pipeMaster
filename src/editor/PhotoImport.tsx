import React from 'react'
import {
  recognize,
  pitchAndStaffAt,
  yForPitch,
  type OmrResult,
  type DetectedNote,
} from '../core/omr/recognize'
import { omrToScore, inferTimeSig, meterForType } from '../core/omr/toScore'
import { ocrHeader } from '../core/omr/ocr'
import { saveOmrExample, downloadOmrDataset } from '../persistence/idb'
import { PITCHES, type Pitch } from '../core/pitch'
import { EMBELLISHMENTS, type EmbellishmentType } from '../core/embellishments/registry'
import type { Score } from '../core/model/types'
import type { Duration, TimeSig } from '../core/duration'
import { barCapacityBeats } from '../core/duration'

const TIME_SIGS: Array<{ label: string; ts: TimeSig }> = [
  { label: '2/4', ts: { beats: 2, unit: 4 } },
  { label: '3/4', ts: { beats: 3, unit: 4 } },
  { label: '4/4', ts: { beats: 4, unit: 4 } },
  { label: '6/8', ts: { beats: 6, unit: 8 } },
  { label: '9/8', ts: { beats: 9, unit: 8 } },
  { label: '12/8', ts: { beats: 12, unit: 8 } },
  { label: '2/2', ts: { beats: 2, unit: 2 } },
  { label: '3/8', ts: { beats: 3, unit: 8 } },
]
const tsLabel = (ts: TimeSig) => `${ts.beats}/${ts.unit}`

/**
 * Take/upload a photo (or PDF page) of pipe music and turn it into a draft.
 * Recognition is imperfect, so the review screen is a full note-by-note editor:
 * each detected note is labelled with its pitch above the image, and you can
 * select a note to change its pitch, length or embellishment, remove it, or tap
 * the staff to add a missed one. Corrections are saved as labelled examples.
 */

interface Props {
  timeSig: TimeSig
  onImport(score: Score): void
  onClose(): void
}

type Stage = 'choose' | 'camera' | 'result'

const PITCH_SHORT: Record<Pitch, string> = {
  LowG: 'LG',
  LowA: 'LA',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  HighG: 'HG',
  HighA: 'HA',
}
const LENGTHS: Array<{ base: Duration['base']; label: string }> = [
  { base: 2, label: '𝅗𝅥' },
  { base: 4, label: '♩' },
  { base: 8, label: '♪' },
  { base: 16, label: '𝅘𝅥𝅯' },
]

/** Rasterise the first page of a PDF to a canvas — pdf.js is loaded on demand. */
async function rasterizePdf(file: File): Promise<HTMLCanvasElement> {
  const pdfjsLib = await import('pdfjs-dist')
  // Vite's ?worker import yields a real Worker constructor, which pdf.js takes
  // via workerPort. The ?url form returned something pdf.js rejected with
  // "Invalid `workerSrc` type", which broke every PDF import. The worker is
  // emitted as a CLASSIC script (see vite.config `worker.format`) so it loads
  // in browsers that reject module workers.
  const workerMod = (await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')) as unknown as {
    default: new () => Worker
  }
  pdfjsLib.GlobalWorkerOptions.workerPort = new workerMod.default()
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const page = await pdf.getPage(1)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(3, Math.max(1, 1500 / base.width))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return canvas
}

export function PhotoImport({ timeSig, onImport, onClose }: Props) {
  const [stage, setStage] = React.useState<Stage>('choose')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<OmrResult | null>(null)
  const [notes, setNotes] = React.useState<DetectedNote[]>([])
  const [selected, setSelected] = React.useState<number | null>(null)
  const [scale, setScale] = React.useState(1)
  const [zoom, setZoom] = React.useState(1)
  // Header fields, auto-filled by OCR and editable before import.
  const [title, setTitle] = React.useState('')
  const [composer, setComposer] = React.useState('')
  const [tuneType, setTuneType] = React.useState('')
  const [ts, setTs] = React.useState<TimeSig>(timeSig)
  const [ocrBusy, setOcrBusy] = React.useState(false)
  // Undo/redo for manual corrections — adding, deleting and editing notes.
  const [history, setHistory] = React.useState<DetectedNote[][]>([])
  const [future, setFuture] = React.useState<DetectedNote[][]>([])
  const imageCanvas = React.useRef<HTMLCanvasElement>(null)
  const overlayCanvas = React.useRef<HTMLCanvasElement>(null)
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const sourceRef = React.useRef<ImageData | null>(null)
  // Guard the browser Back gesture. On a phone a stray edge-swipe navigates
  // away and takes the whole import with it. Push a history entry while the
  // dialog is open so that a Back lands here as a `popstate` we can catch: if
  // there is unsaved work, confirm before discarding; otherwise just close. A
  // beforeunload handler is the backstop for a real page-leave.
  const notesRef = React.useRef<DetectedNote[]>([])
  notesRef.current = notes
  const closeRef = React.useRef(onClose)
  closeRef.current = onClose
  React.useEffect(() => {
    // Add one entry so a Back gesture lands here as a popstate instead of
    // leaving the page. No history.back() in cleanup — doing that fires a
    // popstate the next mount would catch (and it double-fires under React
    // StrictMode); a spare entry left behind is harmless.
    if (!window.history.state?.pmImport) window.history.pushState({ pmImport: true }, '')
    const onPop = () => {
      if (
        notesRef.current.length === 0 ||
        window.confirm('Leave the import? Any corrections you have made will be lost.')
      ) {
        closeRef.current()
      } else {
        // Stay open: replace the entry the Back gesture just consumed.
        window.history.pushState({ pmImport: true }, '')
      }
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (notesRef.current.length > 0) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])

  // Live state for a drag-to-reposition gesture on the overlay.
  const dragRef = React.useRef<{
    i: number // index of the note being dragged, or -1 for an empty-staff press
    startX: number
    startY: number
    moved: boolean
    snapshot: DetectedNote[] // notes before the drag, for a single undo step
  } | null>(null)

  const stopCamera = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])
  React.useEffect(() => () => stopCamera(), [stopCamera])

  const spacing = React.useMemo(() => {
    if (!result || result.staves.length === 0) return 14
    return result.staves.reduce((a, s) => a + s.spacing, 0) / result.staves.length
  }, [result])

  const analyse = React.useCallback((imageData: ImageData, noteheadScale: number) => {
    setBusy(true)
    setSelected(null)
    setTimeout(() => {
      const res = recognize(imageData, { noteheadScale, detectEmbellishments: true })
      setResult(res)
      setNotes(res.notes)
      // Read the meter off the music itself so a 3/4 tune doesn't import as 4/4
      // with every bar a beat short. Header OCR, if it later finds a printed
      // time signature, still refines this.
      const inferred = inferTimeSig(res.notes, res.barlines)
      if (inferred) setTs(inferred)
      setStage('result')
      setBusy(false)
    }, 30)
  }, [])

  const runRecognition = React.useCallback(
    (img: HTMLImageElement | HTMLCanvasElement, w: number, h: number) => {
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const octx = off.getContext('2d', { willReadFrequently: true })!
      octx.drawImage(img, 0, 0, w, h)
      const imageData = octx.getImageData(0, 0, w, h)
      sourceRef.current = imageData
      setScale(1)
      analyse(imageData, 1)
    },
    [analyse],
  )

  // Redraw the image, note markers, and pitch labels on every change.
  React.useEffect(() => {
    if (stage !== 'result' || !result) return
    const ic = imageCanvas.current
    const oc = overlayCanvas.current
    if (!ic || !oc) return
    ic.width = result.width
    ic.height = result.height
    oc.width = result.width
    oc.height = result.height

    const bg = ic.getContext('2d')!.createImageData(result.width, result.height)
    for (let i = 0; i < result.processedGray.length; i++) {
      const v = result.processedGray[i]
      bg.data[i * 4] = v
      bg.data[i * 4 + 1] = v
      bg.data[i * 4 + 2] = v
      bg.data[i * 4 + 3] = 255
    }
    ic.getContext('2d')!.putImageData(bg, 0, 0)

    const ctx = oc.getContext('2d')!
    ctx.clearRect(0, 0, result.width, result.height)
    ctx.textAlign = 'center'
    // Detected gracenotes (amber), drawn under the melody markers. These are the
    // little notes that make up embellishments — shown so you can see what was
    // read, distinct from the melody notes.
    ctx.fillStyle = 'rgba(245,158,11,0.85)'
    ctx.strokeStyle = '#b45309'
    ctx.lineWidth = 1
    notes.forEach((n) => {
      n.graces.forEach((g) => {
        ctx.beginPath()
        ctx.ellipse(g.x, g.y, 4, 3.5, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      })
    })
    notes.forEach((n, i) => {
      const isSel = i === selected
      // Marker.
      ctx.beginPath()
      ctx.lineWidth = isSel ? 2.5 : 1.5
      ctx.strokeStyle = isSel ? '#e11d48' : n.embellishment ? '#9333ea' : '#16a34a'
      ctx.fillStyle = isSel ? 'rgba(225,29,72,0.18)' : 'transparent'
      ctx.ellipse(n.x, n.y, 7, 6, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      // Pitch label above the note.
      const label = PITCH_SHORT[n.pitch] + (n.embellishment ? '·' + shortEmb(n.embellishment) : '')
      const ly = Math.max(12, n.y - spacing * 2.2)
      ctx.font = `bold ${Math.round(spacing * 1.3)}px sans-serif`
      const tw = ctx.measureText(label).width
      ctx.fillStyle = isSel ? '#e11d48' : '#1d4ed8'
      ctx.globalAlpha = 0.9
      ctx.fillStyle = '#fff'
      ctx.fillRect(n.x - tw / 2 - 2, ly - spacing * 1.3, tw + 4, spacing * 1.5)
      ctx.globalAlpha = 1
      ctx.fillStyle = isSel ? '#e11d48' : '#1d4ed8'
      ctx.fillText(label, n.x, ly)
    })
  }, [stage, result, notes, selected, spacing])

  // Read the title / composer / type / metre from the strip above the first
  // staff (OCR, engine fetched on demand). Best-effort: failures are silent.
  React.useEffect(() => {
    if (stage !== 'result' || !result || result.staves.length === 0) return
    let cancelled = false
    const headerBottom = Math.max(30, Math.round(result.staves[0].lines[0]) - 4)
    const cv = document.createElement('canvas')
    cv.width = result.width
    cv.height = result.height
    const cctx = cv.getContext('2d')!
    const im = cctx.createImageData(result.width, result.height)
    for (let i = 0; i < result.processedGray.length; i++) {
      const v = result.processedGray[i]
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v
      im.data[i * 4 + 3] = 255
    }
    cctx.putImageData(im, 0, 0)
    setOcrBusy(true)
    ocrHeader(cv, headerBottom)
      .then((h) => {
        if (cancelled) return
        if (h.title) setTitle(h.title)
        if (h.composer) setComposer(h.composer)
        if (h.tuneType) setTuneType(h.tuneType)
        // Let OCR name the exact meter, but only when it agrees on the bar
        // length the music actually shows — otherwise a misread digit would
        // put back the very mismatch the inference just fixed.
        if (h.timeSig) {
          const inferred = result ? inferTimeSig(notes, result.barlines) : null
          if (!inferred || barCapacityBeats(h.timeSig) === barCapacityBeats(inferred)) {
            setTs(h.timeSig)
          }
        }
        // The named dance settles 3/4 vs 6/8 when the notes can't (a waltz reads
        // as 6/8 by density, but a waltz is always 3/4).
        if (h.tuneType) setTs((prev) => meterForType(prev, h.tuneType))
      })
      .catch(() => {})
      .finally(() => !cancelled && setOcrBusy(false))
    return () => {
      cancelled = true
    }
  }, [stage, result])

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      setBusy(true)
      try {
        const canvas = await rasterizePdf(file)
        runRecognition(canvas, canvas.width, canvas.height)
      } catch {
        setBusy(false)
        alert('Could not read that PDF. Try exporting the page as an image instead.')
      }
      return
    }
    const img = new Image()
    img.onload = () => runRecognition(img, img.naturalWidth, img.naturalHeight)
    img.src = URL.createObjectURL(file)
  }

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      setStage('camera')
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play()
        }
      })
    } catch {
      alert('Could not access the camera. You can upload a photo instead.')
    }
  }

  const capture = () => {
    const v = videoRef.current
    if (!v) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    stopCamera()
    runRecognition(c, c.width, c.height)
  }

  // Every manual edit funnels through mutate() so it can be undone.
  const mutate = (next: DetectedNote[]) => {
    setHistory((h) => [...h.slice(-49), notes])
    setFuture([])
    setNotes(next)
  }
  const undo = () => {
    if (history.length === 0) return
    setFuture((f) => [notes, ...f])
    setNotes(history[history.length - 1])
    setHistory((h) => h.slice(0, -1))
    setSelected(null)
  }
  const redo = () => {
    if (future.length === 0) return
    setHistory((h) => [...h, notes])
    setNotes(future[0])
    setFuture((f) => f.slice(1))
    setSelected(null)
  }

  const toCanvas = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const oc = overlayCanvas.current!
    const rect = oc.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * oc.width,
      y: ((e.clientY - rect.top) / rect.height) * oc.height,
    }
  }

  // Press on a note to grab it, or on empty staff to (later) add one. Dragging a
  // note moves it horizontally and snaps its pitch to wherever you release.
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!result) return
    const { x, y } = toCanvas(e)
    const i = notes.findIndex((n) => Math.hypot(n.x - x, n.y - y) < spacing * 1.1)
    dragRef.current = { i, startX: x, startY: y, moved: false, snapshot: notes }
    if (i >= 0) setSelected(i)
    overlayCanvas.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d || !result || d.i < 0) return
    const { x, y } = toCanvas(e)
    if (!d.moved && Math.hypot(x - d.startX, y - d.startY) < spacing * 0.5) return
    d.moved = true
    const { pitch, staffIndex } = pitchAndStaffAt(result, y)
    const snapY = yForPitch(result, staffIndex, pitch)
    setNotes((prev) => prev.map((n, idx) => (idx === d.i ? { ...n, x, pitch, staffIndex, y: snapY } : n)))
  }

  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || !result) return
    if (d.moved && d.i >= 0) {
      // A completed drag: record the pre-drag notes as one undo step, then
      // re-sort so the moved note keeps left-to-right order.
      setHistory((h) => [...h.slice(-49), d.snapshot])
      setFuture([])
      setNotes((prev) => {
        const moved = prev[d.i]
        const sorted = [...prev].sort((a, b) => a.staffIndex - b.staffIndex || a.x - b.x)
        setSelected(sorted.indexOf(moved))
        return sorted
      })
    } else if (d.i < 0) {
      // A tap on empty staff: add a quaver at that pitch and select it.
      const { pitch, staffIndex } = pitchAndStaffAt(result, d.startY)
      const added: DetectedNote = { pitch, x: d.startX, y: d.startY, staffIndex, base: 8, graces: [] }
      const next = [...notes, added].sort((a, b) => a.staffIndex - b.staffIndex || a.x - b.x)
      mutate(next)
      setSelected(next.indexOf(added))
    }
  }

  const updateSelected = (patch: Partial<DetectedNote>) => {
    if (selected === null || !result) return
    mutate(notes.map((n, i) => (i === selected ? { ...n, ...patch } : n)))
  }
  const setPitch = (pitch: Pitch) => {
    if (selected === null || !result) return
    const n = notes[selected]
    updateSelected({ pitch, y: yForPitch(result, n.staffIndex, pitch) })
  }
  const deleteSelected = () => {
    if (selected === null) return
    mutate(notes.filter((_, i) => i !== selected))
    setSelected(null)
  }
  const clearAll = () => {
    if (notes.length === 0) return
    mutate([])
    setSelected(null)
  }

  const reDetect = (newScale: number) => {
    setScale(newScale)
    setHistory([])
    setFuture([])
    if (sourceRef.current) analyse(sourceRef.current, newScale)
  }

  // Keyboard: ←/→ move selection, ↑/↓ change pitch, Delete removes.
  React.useEffect(() => {
    if (stage !== 'result') return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT') return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? redo() : undo()
        return
      }
      if (selected === null) return
      if (e.key === 'ArrowRight') setSelected(Math.min(notes.length - 1, selected + 1))
      else if (e.key === 'ArrowLeft') setSelected(Math.max(0, selected - 1))
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const idx = PITCHES.indexOf(notes[selected].pitch)
        const ni = Math.max(0, Math.min(PITCHES.length - 1, idx + (e.key === 'ArrowUp' ? 1 : -1)))
        setPitch(PITCHES[ni])
      } else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stage, selected, notes, history, future])

  const doImport = async () => {
    if (!result) return
    try {
      const png = imageCanvas.current?.toDataURL('image/png') ?? ''
      await saveOmrExample({
        at: Date.now(),
        width: result.width,
        height: result.height,
        imagePng: png,
        notes: notes.map((n) => ({
          pitch: n.pitch,
          base: n.base,
          x: Math.round(n.x),
          y: Math.round(n.y),
          embellishment: n.embellishment,
          dotted: n.dotted,
        })),
      })
    } catch {
      /* best-effort */
    }
    onImport(
      omrToScore(notes, ts, title.trim() || 'Imported from photo', {
        composer: composer.trim(),
        tuneType: tuneType.trim(),
        barlines: result.barlines,
        repeats: result.repeats,
        voltas: result.voltas,
        sp: result.staves[0]?.spacing,
      }),
    )
    onClose()
  }

  const sel = selected !== null ? notes[selected] : null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Import from photo or PDF</h2>
          <button className="modal-x" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {stage === 'choose' && (
          <div className="photo-choose">
            <p className="photo-intro">
              Take or upload a photo (or a PDF page) of printed pipe music. pipeMaster finds the
              staves and reads the notes. It won't be perfect — so on the next screen every note is
              labelled with its pitch, and you can <strong>tap a note to fix its pitch, length or
              embellishment</strong>, tap the staff to add a missed one, or remove wrong ones.
            </p>
            <div className="photo-actions">
              <button className="primary" onClick={startCamera}>
                📷 Use camera
              </button>
              <label className="filebtn">
                ⬆ Upload image / PDF
                <input type="file" accept="image/*,application/pdf" onChange={onFile} hidden />
              </label>
            </div>
            <p className="photo-note">
              Corrections are saved on this device to help improve recognition.{' '}
              <button
                className="linkish"
                onClick={() => downloadOmrDataset().then((n) => n === 0 && alert('No examples saved yet.'))}
              >
                Download my examples
              </button>
            </p>
          </div>
        )}

        {stage === 'camera' && (
          <div className="photo-camera">
            <video ref={videoRef} playsInline muted />
            <div className="photo-actions">
              <button className="primary" onClick={capture}>
                Capture
              </button>
              <button
                onClick={() => {
                  stopCamera()
                  setStage('choose')
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {busy && <div className="photo-busy">Analysing image…</div>}

        {stage === 'result' && result && !busy && (
          <div className="photo-result">
            <div className="omr-toolbar">
              <span className="omr-count">
                <strong>{notes.length}</strong> notes
              </span>
              <span className="omr-legend">
                <i className="dot-note" /> note
                <i className="dot-grace" /> gracenote
                <i className="dot-emb" /> embellished
                <i className="dot-sel" /> selected
              </span>
              <span className="omr-spacer" />
              <div className="omr-zoom">
                <button onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 2) / 2))} title="Zoom out">
                  −
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.5) * 2) / 2))} title="Zoom in">
                  +
                </button>
                <button onClick={() => setZoom(1)} title="Fit width" disabled={zoom === 1}>
                  Fit
                </button>
              </div>
              <button onClick={undo} disabled={history.length === 0} title="Undo (⌘Z)">
                ↶ Undo
              </button>
              <button onClick={redo} disabled={future.length === 0} title="Redo (⇧⌘Z)">
                ↷ Redo
              </button>
              <button className="omr-del" onClick={clearAll} disabled={notes.length === 0} title="Remove all notes">
                Clear
              </button>
            </div>
            <div className="photo-canvas-wrap">
              <div className="photo-canvas-inner" style={{ width: `${zoom * 100}%` }}>
                <canvas ref={imageCanvas} className="photo-img" />
                <canvas
                  ref={overlayCanvas}
                  className="photo-overlay"
                  style={{ cursor: 'crosshair', pointerEvents: 'auto', touchAction: 'none' }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
              </div>
            </div>

            {/* Per-note editor */}
            <div className="omr-editor">
              {sel ? (
                <>
                  <div className="omr-row omr-nav">
                    <span className="omr-lbl">
                      Note {(selected ?? 0) + 1} / {notes.length}
                    </span>
                    <button
                      onClick={() => setSelected(Math.max(0, (selected ?? 0) - 1))}
                      disabled={(selected ?? 0) <= 0}
                      title="Previous note (←)"
                    >
                      ‹ Prev
                    </button>
                    <button
                      onClick={() => setSelected(Math.min(notes.length - 1, (selected ?? 0) + 1))}
                      disabled={(selected ?? 0) >= notes.length - 1}
                      title="Next note (→)"
                    >
                      Next ›
                    </button>
                    <button className="omr-deselect" onClick={() => setSelected(null)} title="Deselect">
                      Done
                    </button>
                  </div>
                  <div className="omr-row omr-pitch">
                    <span className="omr-lbl">Pitch</span>
                    {PITCHES.map((p) => (
                      <button
                        key={p}
                        className={sel.pitch === p ? 'active' : ''}
                        onClick={() => setPitch(p)}
                      >
                        {PITCH_SHORT[p]}
                      </button>
                    ))}
                  </div>
                  <div className="omr-row">
                    <span className="omr-lbl">Length</span>
                    {LENGTHS.map((l) => (
                      <button
                        key={l.base}
                        className={sel.base === l.base ? 'active' : ''}
                        onClick={() => updateSelected({ base: l.base })}
                      >
                        {l.label}
                      </button>
                    ))}
                    <button
                      className={sel.dotted ? 'active' : ''}
                      onClick={() => updateSelected({ dotted: !sel.dotted })}
                    >
                      •
                    </button>
                  </div>
                  <div className="omr-row">
                    <span className="omr-lbl">Embellishment</span>
                    <select
                      value={sel.embellishment ?? ''}
                      onChange={(e) =>
                        updateSelected({
                          embellishment: e.target.value ? (e.target.value as EmbellishmentType) : undefined,
                        })
                      }
                    >
                      <option value="">None</option>
                      {EMBELLISHMENTS.filter((d) => d.expand(sel.pitch) !== null).map((d) => (
                        <option key={d.type} value={d.type}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                    <button className="omr-del" onClick={deleteSelected}>
                      Delete note
                    </button>
                  </div>
                </>
              ) : (
                <p className="omr-hint">
                  <strong>Tap a note</strong> to change its pitch/length/embellishment,{' '}
                  <strong>drag a note</strong> to move it and snap its pitch, or tap the staff to add
                  one. ←/→ select, ↑/↓ change pitch, ⌘Z undo.
                </p>
              )}
            </div>

            {/* Tune details — auto-filled from the photo's header text (OCR), editable. */}
            <div className="omr-details">
              <div className="omr-details-head">
                <span className="omr-lbl">Tune details</span>
                {ocrBusy && <span className="omr-ocr">reading text from photo…</span>}
              </div>
              <div className="omr-fields">
                <input
                  className="omr-field omr-field-title"
                  placeholder="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <input
                  className="omr-field"
                  placeholder="Composer"
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                />
                <input
                  className="omr-field omr-field-type"
                  placeholder="Type (e.g. March)"
                  value={tuneType}
                  onChange={(e) => setTuneType(e.target.value)}
                />
                <select
                  className="omr-field omr-field-ts"
                  value={tsLabel(ts)}
                  onChange={(e) => setTs(TIME_SIGS.find((t) => t.label === e.target.value)!.ts)}
                >
                  {TIME_SIGS.map((t) => (
                    <option key={t.label} value={t.label}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="photo-summary">
              <label className="photo-slider">
                Sensitivity
                <input
                  type="range"
                  min={0.6}
                  max={1.6}
                  step={0.1}
                  value={scale}
                  onChange={(e) => reDetect(Number(e.target.value))}
                />
                <span>{scale < 1 ? 'more notes' : scale > 1 ? 'fewer notes' : 'default'}</span>
              </label>
              <div className="photo-actions">
                <button className="primary" disabled={notes.length === 0} onClick={doImport}>
                  Import {notes.length} notes
                </button>
                <button onClick={() => setStage('choose')}>Start over</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function shortEmb(t: EmbellishmentType): string {
  return EMBELLISHMENTS.find((d) => d.type === t)?.short ?? ''
}
