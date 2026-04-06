const VENUE_MAP: Record<string, string> = {
  // Computer Vision
  "proceedings of the ieee/cvf conference on computer vision and pattern recognition": "CVPR",
  "ieee/cvf conference on computer vision and pattern recognition": "CVPR",
  "computer vision and pattern recognition": "CVPR",
  "proceedings of the ieee/cvf international conference on computer vision": "ICCV",
  "ieee/cvf international conference on computer vision": "ICCV",
  "international conference on computer vision": "ICCV",
  "proceedings of the european conference on computer vision": "ECCV",
  "european conference on computer vision": "ECCV",
  // Machine Learning
  "advances in neural information processing systems": "NeurIPS",
  "neural information processing systems": "NeurIPS",
  "proceedings of the international conference on machine learning": "ICML",
  "international conference on machine learning": "ICML",
  "proceedings of the international conference on learning representations": "ICLR",
  "international conference on learning representations": "ICLR",
  // AI
  "proceedings of the aaai conference on artificial intelligence": "AAAI",
  "aaai conference on artificial intelligence": "AAAI",
  "proceedings of the international joint conference on artificial intelligence": "IJCAI",
  // Robotics
  "ieee international conference on robotics and automation": "ICRA",
  "international conference on robotics and automation": "ICRA",
  "ieee/rsj international conference on intelligent robots and systems": "IROS",
  // NLP
  "proceedings of the annual meeting of the association for computational linguistics": "ACL",
  "association for computational linguistics": "ACL",
  "proceedings of the conference on empirical methods in natural language processing": "EMNLP",
  "empirical methods in natural language processing": "EMNLP",
  "proceedings of the north american chapter of the association for computational linguistics": "NAACL",
  // Journals
  "ieee transactions on pattern analysis and machine intelligence": "TPAMI",
  "international journal of computer vision": "IJCV",
  "ieee transactions on image processing": "TIP",
  "ieee transactions on neural networks and learning systems": "TNNLS",
  "journal of machine learning research": "JMLR",
  "nature": "Nature",
  "science": "Science",
  "the visual computer": "TVC",
  "computer graphics forum": "CGF",
  "acm transactions on graphics": "TOG",
  "ieee transactions on visualization and computer graphics": "TVCG",
  // Workshops / preprint
  "arxiv preprint": "arXiv",
  "arxiv": "arXiv",
};

export function mapVenue(raw: string): string {
  const lower = raw.toLowerCase().trim();

  // Direct match
  if (VENUE_MAP[lower]) return VENUE_MAP[lower];

  // Partial match
  for (const [key, short] of Object.entries(VENUE_MAP)) {
    if (lower.includes(key)) return short;
  }

  // Already a short code
  const upper = raw.trim().toUpperCase();
  const knownShort = new Set(Object.values(VENUE_MAP).map((v) => v.toUpperCase()));
  if (knownShort.has(upper)) return raw.trim();

  return raw.trim();
}
