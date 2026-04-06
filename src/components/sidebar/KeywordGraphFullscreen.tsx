import { useEffect, useRef, useMemo } from "react";
import * as d3 from "d3";
import { useKeywordsStore } from "../../stores/keywords";
import { usePapersStore } from "../../stores/papers";
import { useUiStore } from "../../stores/ui";

const PASTEL_PALETTE = [
  "#7eb8f7", "#7dd9c0", "#f7c97e", "#f79fb0",
  "#b19bf7", "#f7a97e", "#a3d977", "#f7e07e",
];

function keywordColor(kw: string): string {
  let hash = 0;
  for (let i = 0; i < kw.length; i++) hash = (hash * 31 + kw.charCodeAt(i)) >>> 0;
  return PASTEL_PALETTE[hash % PASTEL_PALETTE.length];
}

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  kind: "keyword" | "paper";
  count: number;      // keyword: paper count, paper: 0
  label: string;      // display text
  rawId: string;      // paper id (without "paper:" prefix), or keyword string
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  weight: number;
  kind: "kw-paper" | "kw-kw";
}

interface Props {
  onClose: () => void;
}

export function KeywordGraphFullscreen({ onClose }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { keywords } = useKeywordsStore();
  const papers = usePapersStore((s) => s.papers);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const setActivePaper = useUiStore((s) => s.setActivePaper);

  const scopedPapers = useMemo(() => {
    if (!selectedProjectId) return papers;
    return papers.filter((p) => p.project_id === selectedProjectId);
  }, [papers, selectedProjectId]);

  const scopedPaperIds = useMemo(
    () => new Set(scopedPapers.map((p) => p.id)),
    [scopedPapers]
  );
  const scopedKeywords = useMemo(
    () => keywords.filter((k) => scopedPaperIds.has(k.paper_id)),
    [keywords, scopedPaperIds]
  );

  const { nodes, links } = useMemo(() => {
    // Build keyword counts
    const kwCount = new Map<string, number>();
    for (const kw of scopedKeywords) {
      kwCount.set(kw.keyword, (kwCount.get(kw.keyword) ?? 0) + 1);
    }

    // Top 30 keywords
    const topKws = Array.from(kwCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30);
    const kwSet = new Set(topKws.map(([k]) => k));

    // Keyword nodes
    const kwNodes: GraphNode[] = topKws.map(([kw, count]) => ({
      id: `kw:${kw}`,
      kind: "keyword",
      count,
      label: kw.length > 14 ? kw.slice(0, 13) + "…" : kw,
      rawId: kw,
    }));

    // Paper nodes — only papers that have ≥1 keyword in top-30
    const paperHasKw = new Set(
      scopedKeywords.filter((k) => kwSet.has(k.keyword)).map((k) => k.paper_id)
    );
    const paperNodes: GraphNode[] = scopedPapers
      .filter((p) => paperHasKw.has(p.id))
      .map((p) => ({
        id: `paper:${p.id}`,
        kind: "paper",
        count: 0,
        label: p.title.length > 38 ? p.title.slice(0, 36) + "…" : p.title,
        rawId: p.id,
      }));

    const nodes: GraphNode[] = [...kwNodes, ...paperNodes];
    const nodeIds = new Set(nodes.map((n) => n.id));

    const links: GraphLink[] = [];

    // Keyword → Paper links
    for (const kw of scopedKeywords) {
      if (!kwSet.has(kw.keyword)) continue;
      const kwId = `kw:${kw.keyword}`;
      const paperId = `paper:${kw.paper_id}`;
      if (nodeIds.has(kwId) && nodeIds.has(paperId)) {
        links.push({ source: kwId, target: paperId, weight: 1, kind: "kw-paper" });
      }
    }

    // Keyword co-occurrence links
    const paperToKws = new Map<string, string[]>();
    for (const kw of scopedKeywords) {
      if (!kwSet.has(kw.keyword)) continue;
      if (!paperToKws.has(kw.paper_id)) paperToKws.set(kw.paper_id, []);
      paperToKws.get(kw.paper_id)!.push(`kw:${kw.keyword}`);
    }
    const coEdges = new Map<string, number>();
    for (const kws of paperToKws.values()) {
      for (let i = 0; i < kws.length; i++) {
        for (let j = i + 1; j < kws.length; j++) {
          const key = [kws[i], kws[j]].sort().join("\0");
          coEdges.set(key, (coEdges.get(key) ?? 0) + 1);
        }
      }
    }
    for (const [key, count] of coEdges) {
      const [a, b] = key.split("\0");
      links.push({ source: a, target: b, weight: count, kind: "kw-kw" });
    }

    return { nodes, links };
  }, [scopedKeywords, scopedPapers]);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // D3 render
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const W = svg.clientWidth;
    const H = svg.clientHeight;

    d3.select(svg).selectAll("*").remove();
    if (nodes.length === 0) return;

    const maxCount = Math.max(...nodes.filter((n) => n.kind === "keyword").map((n) => n.count), 1);
    const rScale = d3.scaleSqrt().domain([1, maxCount]).range([10, 26]);

    const sim = d3.forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        d3.forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance((l) => (l as GraphLink).kind === "kw-paper" ? 90 : 140)
          .strength((l) => (l as GraphLink).kind === "kw-paper" ? 0.25 : 0.15)
      )
      .force("charge", d3.forceManyBody().strength((d) => (d as GraphNode).kind === "paper" ? -200 : -120))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force(
        "collision",
        d3.forceCollide<GraphNode>().radius((d) =>
          (d as GraphNode).kind === "paper" ? 50 : rScale((d as GraphNode).count) + 6
        )
      )
      .alphaDecay(0.025)
      .velocityDecay(0.4);

    // Zoom
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .on("zoom", (event) => root.attr("transform", event.transform));
    d3.select(svg).call(zoom);

    const root = d3.select(svg).append("g");

    // Links
    const link = root.append("g")
      .selectAll<SVGLineElement, GraphLink>("line")
      .data(links)
      .join("line")
      .attr("stroke", (d) => d.kind === "kw-paper" ? "#58a6ff22" : "#30363d")
      .attr("stroke-opacity", (d) => d.kind === "kw-paper" ? 0.6 : 0.45)
      .attr("stroke-width", (d) => d.kind === "kw-paper" ? 1 : Math.min(d.weight + 0.5, 2.5));

    // Paper nodes
    const paperData = nodes.filter((n) => n.kind === "paper");
    const paperGroup = root.append("g")
      .selectAll<SVGGElement, GraphNode>("g")
      .data(paperData)
      .join("g")
      .attr("cursor", "pointer")
      .on("click", (_e, d) => { setActivePaper(d.rawId); onClose(); })
      .on("mouseenter", function () {
        d3.select(this).select("rect").attr("stroke", "#58a6ff99").attr("fill", "#2d333b");
        d3.select(this).select("text").attr("fill", "#e6edf3");
      })
      .on("mouseleave", function () {
        d3.select(this).select("rect").attr("stroke", "#58a6ff33").attr("fill", "#21262d");
        d3.select(this).select("text").attr("fill", "#8b949e");
      });

    paperGroup.append("rect")
      .attr("rx", 6).attr("ry", 6)
      .attr("x", -72).attr("y", -13)
      .attr("width", 144).attr("height", 26)
      .attr("fill", "#21262d")
      .attr("stroke", "#58a6ff33")
      .attr("stroke-width", 1);

    paperGroup.append("text")
      .text((d) => d.label)
      .attr("text-anchor", "middle")
      .attr("dy", "0.35em")
      .attr("font-size", 9)
      .attr("fill", "#8b949e")
      .attr("pointer-events", "none");

    paperGroup.append("title").text((d) => d.label);

    // Keyword nodes
    const kwData = nodes.filter((n) => n.kind === "keyword");
    const kwGroup = root.append("g")
      .selectAll<SVGGElement, GraphNode>("g")
      .data(kwData)
      .join("g")
      .attr("cursor", "default");

    kwGroup.append("circle")
      .attr("r", (d) => rScale(d.count))
      .attr("fill", (d) => keywordColor(d.rawId))
      .attr("stroke", "#1a1f27")
      .attr("stroke-width", 1);

    // Label below the circle (always on dark background → light color)
    kwGroup.append("text")
      .text((d) => d.label)
      .attr("text-anchor", "middle")
      .attr("dy", (d) => rScale(d.count) + 11)
      .attr("font-size", 10)
      .attr("fill", "#c9d1d9")
      .attr("pointer-events", "none");

    kwGroup.append("title").text((d) => `${d.rawId} — ${d.count} paper${d.count > 1 ? "s" : ""}`);

    sim.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
        .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
        .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
        .attr("y2", (d) => (d.target as GraphNode).y ?? 0);
      paperGroup.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      kwGroup.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    sim.on("end", () => sim.stop());
    return () => { sim.stop(); };
  }, [nodes, links, setActivePaper, onClose]);

  const kwCount = nodes.filter((n) => n.kind === "keyword").length;
  const paperCount = nodes.filter((n) => n.kind === "paper").length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg-primary">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <span className="text-section font-bold uppercase tracking-wider text-text-secondary">
          Keyword Graph
        </span>
        <div className="flex items-center gap-6">
          {/* Legend */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-[#7eb8f7] opacity-85" />
              <span className="text-small text-text-tertiary">Keyword ({kwCount})</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-3 rounded bg-[#21262d] border border-[#58a6ff33]" />
              <span className="text-small text-text-tertiary">Paper ({paperCount}) — click to open</span>
            </div>
            <span className="text-small text-text-tertiary">Scroll to zoom · Drag to pan</span>
          </div>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary transition-colors px-2 py-0.5 rounded hover:bg-bg-tertiary text-body"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Graph area */}
      {nodes.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-body text-text-tertiary">
            No keywords yet — import papers to build the graph.
          </span>
        </div>
      ) : (
        <svg ref={svgRef} className="flex-1 w-full" />
      )}
    </div>
  );
}
