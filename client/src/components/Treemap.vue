<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from "d3-hierarchy";
import type { TreemapNode } from "../types";
import { colorFor } from "../utils/color";

const props = defineProps<{ node: TreemapNode }>();
const emit = defineEmits<{
  drill: [chain: TreemapNode[]];
  hover: [node: TreemapNode | null];
}>();

const wrapperRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

let laidOutLeaves: HierarchyRectangularNode<TreemapNode>[] = [];
let resizeObserver: ResizeObserver | undefined;

function draw(): void {
  const wrapper = wrapperRef.value;
  const canvas = canvasRef.value;
  if (!wrapper || !canvas) return;

  const width = wrapper.clientWidth;
  const height = wrapper.clientHeight;
  if (width === 0 || height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const root = hierarchy<TreemapNode>(props.node, (d) => (d.children && d.children.length > 0 ? d.children : undefined)).sum(
    (d) => (d.children ? 0 : d.size),
  );

  laidOutLeaves = [];
  if (!root.value) return;

  const laidOutRoot = treemap<TreemapNode>().tile(treemapSquarify).paddingInner(1).size([width, height])(root);

  for (const leaf of laidOutRoot.leaves()) {
    const w = leaf.x1 - leaf.x0;
    const h = leaf.y1 - leaf.y0;
    if (w < 0.5 || h < 0.5) continue;

    ctx.fillStyle = colorFor(leaf.data);
    ctx.fillRect(leaf.x0, leaf.y0, w, h);

    if (w > 3 && h > 3) {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
      ctx.lineWidth = 1;
      ctx.strokeRect(leaf.x0 + 0.5, leaf.y0 + 0.5, w - 1, h - 1);
    }

    if (w > 40 && h > 14) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      ctx.font = "11px sans-serif";
      ctx.save();
      ctx.beginPath();
      ctx.rect(leaf.x0, leaf.y0, w, h);
      ctx.clip();
      ctx.fillText(leaf.data.name, leaf.x0 + 3, leaf.y0 + 12);
      ctx.restore();
    }

    laidOutLeaves.push(leaf);
  }
}

function leafAt(offsetX: number, offsetY: number): HierarchyRectangularNode<TreemapNode> | undefined {
  return laidOutLeaves.find((leaf) => offsetX >= leaf.x0 && offsetX < leaf.x1 && offsetY >= leaf.y0 && offsetY < leaf.y1);
}

function onClick(event: MouseEvent): void {
  const leaf = leafAt(event.offsetX, event.offsetY);
  if (!leaf) return;

  const dirNode = leaf.data.kind === "directory" ? leaf : leaf.parent;
  if (!dirNode || dirNode.data === props.node) return;

  const chain: TreemapNode[] = [];
  let current: HierarchyRectangularNode<TreemapNode> | null = dirNode;
  while (current && current.data !== props.node) {
    chain.unshift(current.data);
    current = current.parent;
  }
  if (chain.length > 0) emit("drill", chain);
}

function onMouseMove(event: MouseEvent): void {
  const leaf = leafAt(event.offsetX, event.offsetY);
  emit("hover", leaf?.data ?? null);
}

function onMouseLeave(): void {
  emit("hover", null);
}

onMounted(() => {
  draw();
  resizeObserver = new ResizeObserver(() => draw());
  if (wrapperRef.value) resizeObserver.observe(wrapperRef.value);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});

watch(() => props.node, draw);
</script>

<template>
  <div ref="wrapperRef" class="treemap-wrapper">
    <canvas ref="canvasRef" @click="onClick" @mousemove="onMouseMove" @mouseleave="onMouseLeave"></canvas>
  </div>
</template>

<style scoped>
.treemap-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

canvas {
  display: block;
  cursor: pointer;
}
</style>
