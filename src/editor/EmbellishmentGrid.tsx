import { EMBELLISHMENTS, type EmbellishmentType } from '../core/embellishments/registry'
import type { Note } from '../core/model/types'
import { EmbellishmentPreview } from './EmbellishmentPreview'

const CATEGORIES = ['Gracenotes', 'Doublings', 'Strikes', 'Movements'] as const

interface Props {
  selectedNote: Note | undefined
  onApply(type: EmbellishmentType): void
  onClear(): void
}

export function EmbellishmentGrid({ selectedNote, onApply, onClear }: Props) {
  const activeType = selectedNote?.embellishment?.type

  return (
    <div>
      <div className="emb-head">
        <h3>Embellishments</h3>
        <button
          className="emb-clear"
          disabled={!selectedNote || !activeType}
          onClick={onClear}
          title="Remove embellishment (0)"
        >
          Clear
        </button>
      </div>
      {!selectedNote && <p className="emb-hint">Select a note to add an embellishment.</p>}

      {CATEGORIES.map((cat) => {
        const defs = EMBELLISHMENTS.filter((d) => d.category === cat)
        return (
          <div className="emb-cat" key={cat}>
            <div className="emb-cat-label">{cat}</div>
            <div className="emb-grid">
              {defs.map((d) => {
                // Applicability only dims the click affordance; cards stay
                // draggable so they can be dropped on any valid note.
                const dim = selectedNote !== undefined && d.expand(selectedNote.pitch) === null
                const active = activeType === d.type
                return (
                  <button
                    key={d.type}
                    className={`emb-card${active ? ' active' : ''}${dim ? ' dim' : ''}`}
                    title={`${d.label} — drag onto a note, or select a note and click`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(
                        'application/x-pm',
                        JSON.stringify({ kind: 'emb', type: d.type }),
                      )
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => onApply(d.type)}
                  >
                    <EmbellishmentPreview type={d.type} />
                    <span className="emb-name">{d.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
