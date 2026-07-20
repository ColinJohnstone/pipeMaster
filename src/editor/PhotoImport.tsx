import React from 'react'
import { recognize, type OmrResult } from '../core/omr/recognize'
import { omrToScore } from '../core/omr/toScore'
import type { Score } from '../core/model/types'
import type { TimeSig } from '../core/duration'

/**
 * Take/upload a photo of pipe music and turn it into an editable draft.
 * The recognition (see core/omr/recognize.ts) finds staves and noteheads and
 * reads pitches; rhythm and embellishments are added by hand afterwards.
 */

interface Props {
  timeSig: TimeSig
  onImport(score: Score): void
  onClose(): void
}

type Stage = 'choose' | 'camera' | 'result'

export function PhotoImport({ timeSig, onImport, onClose }: Props) {
  const [stage, setStage] = React.useState<Stage>('choose')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<OmrResult | null>(null)
  const imageCanvas = React.useRef<HTMLCanvasElement>(null)
  const overlayCanvas = React.useRef<HTMLCanvasElement>(null)
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const streamRef = React.useRef<MediaStream | null>(null)

  const stopCamera = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  React.useEffect(() => () => stopCamera(), [stopCamera])

  const runRecognition = React.useCallback((img: HTMLImageElement | HTMLCanvasElement, w: number, h: number) => {
    setBusy(true)
    // Draw at native size to an offscreen canvas for pixel access.
    const off = document.createElement('canvas')
    off.width = w
    off.height = h
    const octx = off.getContext('2d', { willReadFrequently: true })!
    octx.drawImage(img, 0, 0, w, h)
    const imageData = octx.getImageData(0, 0, w, h)

    // Defer so the busy state paints before the (synchronous) CV work.
    setTimeout(() => {
      const res = recognize(imageData)
      setResult(res)
      setStage('result')
      setBusy(false)
      // Draw the processed-size image and the detection overlay.
      requestAnimationFrame(() => {
        const ic = imageCanvas.current
        const oc = overlayCanvas.current
        if (!ic || !oc) return
        ic.width = res.width
        ic.height = res.height
        oc.width = res.width
        oc.height = res.height
        // Show the processed (deskewed) image so the overlay lines up with it.
        const bg = ic.getContext('2d')!.createImageData(res.width, res.height)
        for (let i = 0; i < res.processedGray.length; i++) {
          const v = res.processedGray[i]
          bg.data[i * 4] = v
          bg.data[i * 4 + 1] = v
          bg.data[i * 4 + 2] = v
          bg.data[i * 4 + 3] = 255
        }
        ic.getContext('2d')!.putImageData(bg, 0, 0)

        const ctx = oc.getContext('2d')!
        ctx.clearRect(0, 0, res.width, res.height)
        ctx.strokeStyle = 'rgba(76,141,255,0.4)'
        ctx.lineWidth = 1
        for (const s of res.staves) {
          for (const ly of s.lines) {
            ctx.beginPath()
            ctx.moveTo(0, ly)
            ctx.lineTo(res.width, ly)
            ctx.stroke()
          }
        }
        // Gracenotes (blue), then melody noteheads (green) on top.
        for (const n of res.notes) {
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
        for (const n of res.notes) {
          ctx.beginPath()
          ctx.fillStyle = n.embellishment ? 'rgba(168,85,247,0.3)' : 'rgba(34,197,94,0.35)'
          ctx.strokeStyle = n.embellishment ? '#9333ea' : '#16a34a'
          ctx.lineWidth = 1.5
          ctx.ellipse(n.x, n.y, 6, 5, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        }
      })
    }, 30)
  }, [])

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const img = new Image()
    img.onload = () => runRecognition(img, img.naturalWidth, img.naturalHeight)
    img.src = URL.createObjectURL(file)
  }

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
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
    const w = v.videoWidth
    const h = v.videoHeight
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')!.drawImage(v, 0, 0, w, h)
    stopCamera()
    runRecognition(c, w, h)
  }

  const doImport = () => {
    if (!result) return
    onImport(omrToScore(result.notes, timeSig, 'Imported from photo'))
    onClose()
  }

  const noteCount = result?.notes.length ?? 0
  const embCount = result?.notes.filter((n) => n.embellishment).length ?? 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Import from photo</h2>
          <button className="modal-x" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {stage === 'choose' && (
          <div className="photo-choose">
            <p className="photo-intro">
              Take or upload a photo of printed pipe music. pipeMaster straightens the page,
              finds the staves, and reads notehead <strong>pitches</strong>,{' '}
              <strong>embellishments</strong> (by matching the gracenote patterns), and dots,
              dropping them into the editor as a draft. Note lengths default to quavers, so you
              tidy the rhythm afterward. Works best on sharp, high-contrast photos cropped to the
              music.
            </p>
            <div className="photo-actions">
              <button className="primary" onClick={startCamera}>
                📷 Use camera
              </button>
              <label className="filebtn">
                ⬆ Upload image
                <input type="file" accept="image/*" onChange={onFile} hidden />
              </label>
            </div>
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

        {stage === 'result' && result && (
          <div className="photo-result">
            <div className="photo-canvas-wrap">
              <canvas ref={imageCanvas} className="photo-img" />
              <canvas ref={overlayCanvas} className="photo-overlay" />
            </div>
            <div className="photo-summary">
              <p>
                Found <strong>{result.staves.length}</strong>{' '}
                {result.staves.length === 1 ? 'staff' : 'staves'} and detected{' '}
                <strong>{noteCount}</strong> {noteCount === 1 ? 'note' : 'notes'} (green /{' '}
                <span style={{ color: '#a855f7' }}>purple = embellished</span>), with{' '}
                <strong>{embCount}</strong> embellishment{embCount === 1 ? '' : 's'} matched
                (gracenotes in blue).
              </p>
              {Math.abs(result.skewDeg) > 0.5 && (
                <p className="photo-note">Straightened the page by {result.skewDeg.toFixed(1)}°.</p>
              )}
              {result.warnings.map((w, i) => (
                <p key={i} className="photo-warn">
                  ⚠ {w}
                </p>
              ))}
              <p className="photo-note">
                A draft to refine — pitches, embellishments, and dots are detected; note lengths
                default to quavers. Import it, then tidy the rhythm in the editor.
              </p>
              <div className="photo-actions">
                <button className="primary" disabled={noteCount === 0} onClick={doImport}>
                  Import {noteCount} notes to editor
                </button>
                <button onClick={() => setStage('choose')}>Try another photo</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
