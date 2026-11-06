import type { Core } from "cytoscape"

export function viewport(graph: Core, container: HTMLElement) {
  let frame = 0
  let pending = false
  let closed = false
  let width = 0
  let height = 0

  function schedule() {
    if (closed || frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (closed || graph.destroyed()) return
      const rect = container.getBoundingClientRect()
      // Hidden tables/request placeholders cannot provide a usable fit. Keep
      // the request pending until ResizeObserver sees the canvas again.
      if (!rect.width || !rect.height) return
      const changed = rect.width !== width || rect.height !== height
      width = rect.width
      height = rect.height
      graph.resize()
      if ((pending || changed) && graph.nodes().length) {
        graph.fit(undefined, Math.min(70, width / 8, height / 8))
        pending = false
      }
    })
  }

  const observer = new ResizeObserver(schedule)
  observer.observe(container)
  return {
    fit() { pending = true; schedule() },
    resize: schedule,
    dispose() {
      closed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
    },
  }
}
