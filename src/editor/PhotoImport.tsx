import React from 'react'
import { recognize, pitchAndStaffAt, type OmrResult, type DetectedNote } from '../core/omr/recognize'
import { omrToScore } from '../core/omr/toScore'
import { saveOmrExample, downloadOmrDataset } from '../persistence/idb'
import type { Score } from '../core/model/types'
import type { TimeSig } from '../core/duration'

/**
 * Take/upload a photo (or PDF page) of pipe music and turn it into a draft.
 * After the first automatic guess you can correct it — tap a wrong notehead to
 * remove it, tap the staff to add a missed one, and nudge the detection
 * sensitivity to re-run. Your corrections both fix this import and are saved as
 * labelled examples to improve recognition over time.
 */

interface Props {
  timeSig: TimeSig
  onImport(score: Score): void
  onClose(): void
}

type Stage = 'choose' | 'camera' | 'result'

const DUR: Record<number, string> = { 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯', 32: '𝅘𝅥𝅰' }

/** Rasterise the first page of a PDF to a canvas — pdf.js is loaded on demand. */
async function rasterizePdf(file: File): Promise<HTMLCanvasElement> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = (
    await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ).default
  const buf = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise
  const page = await pdf.getPage(1)
  // Render at ~1500px wide for a good OMR resolution.
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
  const [scale, setScale] = React.useState(1)
  const [detectEmb, setDetectEmb] = React.useState(false)
  const imageCanvas = React.useRef<HTMLCanvasElement>(null)
  const overlayCanvas = React.useRef<HTMLCanvasElement>(null)
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const sourceRef = React.useRef<ImageData | null>(null)

  const stopCamera = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])
  React.useEffect(() => () => stopCamera(), [stopCamera])

  /** Median staff spacing, used for hit-testing and default note size. */
  const spacing = React.useMemo(() => {
    if (!result || result.staves.length === 0) return 14
    return result.staves.reduce((a, s) => a + s.spacing, 0) / result.staves.length
  }, [result])

  const analyse = React.useCallback(
    (imageData: ImageData, noteheadScale: number, embellishments: boolean) => {
      setBusy(true)
      setTimeout(() => {
        const res = recognize(imageData, {
          noteheadScale,
          detectEmbellishments: embellishments,
        })
        setResult(res)
        setNotes(res.notes)
        setStage('result')
        setBusy(false)
      }, 30)
    },
    [],
  )

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
      analyse(imageData, 1, detectEmb)
    },
    [analyse, detectEmb],
  )

  // Redraw the image + overlay whenever the result or edited notes change.
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
    ctx.strokeStyle = 'rgba(76,141,255,0.4)'
    ctx.lineWidth = 1
    for (const s of result.staves) {
      for (const ly of s.lines) {
        ctx.beginPath()
        ctx.moveTo(0, ly)
        ctx.lineTo(result.width, ly)
        ctx.stroke()
      }
    }
    for (const n of notes) {
      for (const g of n.graces) {
        ctx.beginPath()
        ctx.fillStyle = 'rgba(59,130,246,0.45)'
        ctx.strokeStyle = '#2563eb'
        ctx.lineWidth = 1
        ctx.ellipse(g.x, g.y, 3.5, 3, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    for (const n of notes) {
      ctx.beginPath()
      ctx.fillStyle = n.embellishment ? 'rgba(168,85,247,0.3)' : 'rgba(34,197,94,0.35)'
      ctx.strokeStyle = n.embellishment ? '#9333ea' : '#16a34a'
      ctx.lineWidth = 1.5
      ctx.ellipse(n.x, n.y, 6, 5, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#b45309'
      ctx.fillText((DUR[n.base] ?? '') + (n.dotted ? '.' : ''), n.x, n.y - 9)
    }
  }, [stage, result, notes])

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

  // Tap the overlay to add a note, or tap a detected note to remove it.
  const onOverlayClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!result) return
    const oc = overlayCanvas.current!
    const rect = oc.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * oc.width
    const y = ((e.clientY - rect.top) / rect.height) * oc.height

    const hit = notes.findIndex((n) => Math.hypot(n.x - x, n.y - y) < spacing * 0.8)
    if (hit >= 0) {
      setNotes(notes.filter((_, i) => i !== hit))
      return
    }
    const { pitch, staffIndex } = pitchAndStaffAt(result, y)
    const added: DetectedNote = { pitch, x, y, staffIndex, base: 8, graces: [] }
    setNotes([...notes, added].sort((a, b) => a.staffIndex - b.staffIndex || a.x - b.x))
  }

  const reDetect = (newScale: number, emb: boolean) => {
    setScale(newScale)
    setDetectEmb(emb)
    if (sourceRef.current) analyse(sourceRef.current, newScale, emb)
  }

  const doImport = async () => {
    if (!result) return
    // Save this corrected page as a labelled example (best-effort).
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
      /* storage is best-effort */
    }
    onImport(omrToScore(notes, timeSig, 'Imported from photo'))
    onClose()
  }

  const embCount = notes.filter((n) => n.embellishment).length

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Import from photo or PDF</h2>
          <button className="modal-x" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {stage === 'choose' && (
          <div className="photo-choose">
            <p className="photo-intro">
              Take or upload a photo (or a PDF page) of printed pipe music. pipeMaster straightens
              the page, finds the staves, and reads the <strong>notes and their lengths</strong>{' '}
              (clef, time signature and page text are ignored). It won't be perfect — so on the next
              screen you can <strong>tap to add or remove notes</strong> and tune the sensitivity
              before importing. Works best on a sharp, high-contrast image cropped to the music.
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
              Corrections you make are saved on this device to help improve recognition.{' '}
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
            <div className="photo-canvas-wrap">
              <canvas ref={imageCanvas} className="photo-img" />
              <canvas
                ref={overlayCanvas}
                className="photo-overlay"
                style={{ cursor: 'crosshair', pointerEvents: 'auto' }}
                onClick={onOverlayClick}
              />
            </div>
            <div className="photo-summary">
              <p>
                <strong>{result.staves.length}</strong>{' '}
                {result.staves.length === 1 ? 'staff' : 'staves'}, <strong>{notes.length}</strong>{' '}
                notes detected{detectEmb && embCount > 0 ? ` (${embCount} embellished)` : ''}.{' '}
                <strong>Tap the staff to add a note; tap a note to remove it.</strong>
              </p>
              <label className="photo-slider">
                Sensitivity
                <input
                  type="range"
                  min={0.6}
                  max={1.6}
                  step={0.1}
                  value={scale}
                  onChange={(e) => reDetect(Number(e.target.value), detectEmb)}
                />
                <span>{scale < 1 ? 'more notes' : scale > 1 ? 'fewer notes' : 'default'}</span>
              </label>
              <label className="photo-check">
                <input
                  type="checkbox"
                  checked={detectEmb}
                  onChange={(e) => reDetect(scale, e.target.checked)}
                />
                Also detect embellishments (experimental)
              </label>
              {result.warnings.map((w, i) => (
                <p key={i} className="photo-warn">
                  ⚠ {w}
                </p>
              ))}
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
