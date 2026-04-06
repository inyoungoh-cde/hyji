import { useEffect, useRef, useMemo } from "react";
import * as d3 from "d3";
import { useKeywordsStore } from "../../stores/keywords";
import { usePapersStore } from "../../stores/papers";
import { useUiStore } from "../../stores/ui";

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  count: number;
  paperIds: Set<string>;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  count: number;
}

const PASTEL_PALETTE = [
  "#7eb8f7", "#7dd9c0", "#f7c97e", "#f79fb0",
  "#b19bf7", "#f7a97e", "#a3d977", "#f7e07e",
];

function keywordColor(kw: string): string {
  let hash = 0;
  for (let i = 0; i < kw.length; i++) hash = (hash * 31 + kw.charCodeAt(i)) >>> 0;
  return PASTEL_PALETTE[hash % PASTEL_PALETTE.length];
}

export function KeywordGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const { keywords, fetchKeywords, autoExtractForPapers } = useKeywordsStore();
  const papers = usePapersStore((s) => s.papers);
  const selectedProjectId = useUiStore((s) => s.selectedProjectId);
  const keywordFilter = useUiStore((s) => s.keywordFilter);
  const setKeywordFilter = useUiStore((s) => s.setKeywordFilter);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);

  // Stable paper-id string: re-run extraction whenever paper set changes
  const paperIdKey = papers.map((p) => p.id).join(",");

  useEffect(() => {
    if (papers.length === 0) {
      // Refresh from DB so stale in-memory keywords are cleared
      fetchKeywords();
      return;
    }
    fetchKeywords().then(() => autoExtractForPapers(papers));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperIdKey]);

  // Filter papers by selected project
  const projectPaperIds = useMemo(() => {
    if (!selectedProjectId) return null; // null = all papers
    return new Set(papers.filter((p) => p.project_id === selectedProjectId).map((p) => p.id));
  }, [papers, selectedProjectId]);

  // Filter keywords to only those belonging to project papers
  const scopedKeywords = useMemo(() => {
    if (!projectPaperIds) return keywords;
    return keywords.filter((k) => projectPaperIds.has(k.paper_id));
  }, [keywords, projectPaperIds]);

  // Build graph data from scoped keywords
  const { nodes, links } = useMemo(() => {
    const nodeMap = new Map<string, GraphNode>();

    for (const kw of scopedKeywords) {
      if (!nodeMap.has(kw.keyword)) {
        nodeMap.set(kw.keyword, { id: kw.keyword, count: 0, paperIds: new Set() });
      }
      const node = nodeMap.get(kw.keyword)!;
      node.count++;
      node.paperIds.add(kw.paper_id);
    }

    // Limit to top 25 nodes by paper count to keep graph readable
    const nodes = Array.from(nodeMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    // Only allow links between nodes that are actually in the top-25 set
    const nodeSet = new Set(nodes.map((n) => n.id));

    const paperToKeywords = new Map<string, string[]>();
    for (const kw of scopedKeywords) {
      if (!paperToKeywords.has(kw.paper_id)) paperToKeywords.set(kw.paper_id, []);
      paperToKeywords.get(kw.paper_id)!.push(kw.keyword);
    }

    const edgeMap = new Map<string, number>();
    for (const kws of paperToKeywords.values()) {
      for (let i = 0; i < kws.length; i++) {
        for (let j = i + 1; j < kws.length; j++) {
          const key = [kws[i], kws[j]].sort().join("\0");
          edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
        }
      }
    }

    const links: GraphLink[] = [];
    for (const [key, count] of edgeMap) {
      const [a, b] = key.split("\0");
      if (nodeSet.has(a) && nodeSet.has(b)) {
        links.push({ source: a, target: b, count });
      }
    }

    return { nodes, links };
  }, [scopedKeywords]);

  // D3 rendering
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const W = svg.clientWidth || 200;
    const H = svg.clientHeight || 160;

    d3.select(svg).selectAll("*").remove();
    if (nodes.length === 0) return;

    const maxCount = Math.max(...nodes.map((n) => n.count));
    const rScale = d3.scaleSqrt().domain([1, Math.max(maxCount, 1)]).range([5, 13]);

    const sim = d3.forceSimulation<GraphNode>(nodes)
      .force("link", d3.forceLink<GraphNode, GraphLink>(links)
        .id((d) => d.id).distance(40).strength(0.4))
      .force("charge", d3.forceManyBody().strength(-60))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collision", d3.forceCollide<GraphNode>().radius((d) => rScale(d.count) + 3))
      .alphaDecay(0.04)
      .velocityDecay(0.5);

    const root = d3.select(svg).append("g");

    const link = root.append("g")
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke", "#30363d")
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", (d) => Math.min(d.count + 0.5, 3));

    const node = root.append("g")
      .selectAll<SVGGElement, GraphNode>("g")
      .data(nodes)
      .join("g")
      .attr("cursor", "pointer")
      .on("click", (_e, d) => {
        setKeywordFilter(keywordFilter === d.id ? null : d.id);
      });

    node.append("circle")
      .attr("r", (d) => rScale(d.count))
      .attr("fill", (d) => keywordColor(d.id))
      .attr("fill-opacity", (d) => (keywordFilter && keywordFilter !== d.id ? 0.25 : 0.85))
      .attr("stroke", (d) => (keywordFilter === d.id ? "#e6edf3" : "none"))
      .attr("stroke-width", 1.5);

    node.append("title").text((d) => `${d.id} (${d.count})`);

    node.append("text")
      .text((d) => d.id.length > 10 ? d.id.slice(0, 9) + "…" : d.id)
      .attr("text-anchor", "middle")
      .attr("dy", (d) => rScale(d.count) + 9)
      .attr("font-size", 8)
      .attr("fill", "#8b949e")
      .attr("pointer-events", "none");

    sim.on("tick", () => {
      nodes.forEach((d) => {
        const r = rScale(d.count);
        d.x = Math.max(r, Math.min(W - r, d.x ?? W / 2));
        d.y = Math.max(r, Math.min(H - r, d.y ?? H / 2));
      });
      link
        .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
        .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
        .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
        .attr("y2", (d) => (d.target as GraphNode).y ?? 0);
      node.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    sim.on("end", () => sim.stop());
    return () => { sim.stop(); };
  }, [nodes, links, keywordFilter, setKeywordFilter, sidebarWidth]);

  if (nodes.length === 0) {
    return (
      <div className="mt-2 h-[100px] rounded-[8px] bg-bg-tertiary/50 flex items-center justify-center">
        <span className="text-small text-text-tertiary">No keywords yet</span>
      </div>
    );
  }

  return (
    <div className="mt-2 relative">
      {keywordFilter && (
        <div className="flex items-center gap-1 mb-1">
          <span className="text-caption text-accent truncate max-w-[120px]">{keywordFilter}</span>
          <button
            onClick={() => setKeywordFilter(null)}
            className="text-caption text-text-tertiary hover:text-accent transition-colors"
          >
            ✕
          </button>
        </div>
      )}
      <svg
        ref={svgRef}
        className="w-full rounded-[8px] bg-bg-tertiary/30"
        style={{ height: 160 }}
      />
    </div>
  );
}
