import { useEffect, useRef, useState } from 'react'
import { PieceSummary } from '@/lib/api/types'
import { IntegrationCard, IntegrationCardSkeleton } from './integration-card'

const INITIAL_VISIBLE_COUNT = 21
const LOAD_STEP = 21

interface IntegrationGridProps {
  pieces: PieceSummary[]
}

export function IntegrationGrid({ pieces }: IntegrationGridProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_COUNT)
  }, [pieces])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((count) => Math.min(count + LOAD_STEP, pieces.length))
        }
      },
      { rootMargin: '400px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [pieces.length])

  const visiblePieces = pieces.slice(0, visibleCount)

  return (
    <div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visiblePieces.map((piece) => (
          <IntegrationCard key={piece.name} piece={piece} />
        ))}
      </div>
      {visibleCount < pieces.length && <div ref={sentinelRef} className="h-px" aria-hidden="true" />}
    </div>
  )
}

interface IntegrationGridSkeletonProps {
  count?: number
}

export function IntegrationGridSkeleton({ count = 9 }: IntegrationGridSkeletonProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <IntegrationCardSkeleton key={index} />
      ))}
    </div>
  )
}
