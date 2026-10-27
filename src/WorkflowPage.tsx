import { useEffect, useRef, useState, type ReactNode } from "react";

export type SectionRequest = { id: string; ticket: number } | null;
export type WorkflowSection = {
  id: string;
  label: string;
  content: ReactNode;
};

/** Related tools share a document and remain mounted after first use. The
 * chapter controls scroll; they never replace one tool with another. */
export function WorkflowPage({
  id,
  label,
  sections,
  request = null,
}: {
  id: string;
  label: string;
  sections: WorkflowSection[];
  request?: SectionRequest;
}) {
  const [opened, setOpened] = useState<Record<string, boolean>>({
    [sections[0].id]: true,
  });
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const visited = useRef(new Set([sections[0].id]));
  const sectionIds = sections.map((section) => section.id).join("|");
  const jump = (sectionId: string) => {
    if (!sectionIds.split("|").includes(sectionId)) return;
    visited.current.add(sectionId);
    setOpened((current) => ({ ...current, [sectionId]: true }));
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const target = root.current?.querySelector<HTMLElement>(
        `[data-workflow-section="${sectionId}"]`,
      );
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });
  };
  useEffect(() => {
    if (request) jump(request.id);
  }, [request?.ticket, request?.id]);
  useEffect(() => {
    const targets = root.current?.querySelectorAll<HTMLElement>(
      "[data-workflow-section]",
    );
    if (!targets) return;
    if (typeof IntersectionObserver === "undefined") {
      setOpened(
        Object.fromEntries(sectionIds.split("|").map((key) => [key, true])),
      );
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        // Expand at most one new chapter per layout notification. Its real
        // height then moves later placeholders below the viewport, avoiding
        // a burst of requests without padding the document with blank pages.
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = (entry.target as HTMLElement).dataset.workflowSection!;
          if (visited.current.has(key)) {
            observer.unobserve(entry.target);
            continue;
          }
          visited.current.add(key);
          setOpened((current) =>
            current[key] ? current : { ...current, [key]: true },
          );
          observer.unobserve(entry.target);
          break;
        }
      },
      { rootMargin: "160px" },
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [sectionIds]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return (
    <div className="workflow-page" ref={root}>
      <nav className="workflow-chapters" aria-label={`${label}章节定位`}>
        <strong>{label}</strong>
        <span>同页处理 · 点击定位</span>
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => jump(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      {sections.map((section) => (
        <section
          key={section.id}
          id={`${id}-${section.id}`}
          data-workflow-section={section.id}
          aria-label={section.label}
          tabIndex={-1}
          className={`workflow-section${opened[section.id] ? "" : " workflow-section-pending"}`}
        >
          {opened[section.id] ? (
            section.content
          ) : (
            <div className="rc4-panel">
              <h2>{section.label}</h2>
              <p>在本页继续处理，滚动到此处时读取数据。</p>
              <button type="button" onClick={() => jump(section.id)}>
                展开{section.label}
              </button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
