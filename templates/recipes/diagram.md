# 交互图形配方

由 OpenMAIC `diagram-content/system.md` 适配（MIT），保留节点/边、稳定 ID、连接点计算与定位/动画分离范例；不依赖其平台主动控制。来源见 [UPSTREAM.json](UPSTREAM.json)。

## 先决定是否需要定制

关系表、已有 SVG 或组件已能讲清时直接复用。确需局部节点揭示、点击标注或状态对比时，生成一个嵌入当前课程的小图；不重新设计全页字体、背景或导航。

输入只含节点、连线、要揭示的次序与本图回答的问题。节点用稳定 ID；图中数值从材料或同一计算函数产生。离线资源放课程清单内，不使用 CDN、任意 iframe 消息控制或隐式网络请求。

## 复用范例

OpenMAIC 的定位和状态变化分两层，避免 hover 覆盖 SVG 坐标导致节点跳到原点：

```html
<g id="node-n1" transform="translate(320, 180)">
  <g class="node-body">
    <rect x="-90" y="-35" width="180" height="70"></rect>
    <text text-anchor="middle" dy="6">节点</text>
  </g>
</g>
```

箭头接节点边界，以下为上游连接点算法的局部复用；尺寸须与真实节点一致：

```js
const NODE_WIDTH = 180, NODE_HEIGHT = 70, ARROW_OFFSET = 10;
function getEdgePoints(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  let sx, sy, ex, ey;
  if (Math.abs(dy) > Math.abs(dx)) {
    sx = from.x;
    sy = dy > 0 ? from.y + NODE_HEIGHT / 2 : from.y - NODE_HEIGHT / 2;
    ex = to.x;
    ey = dy > 0 ? to.y - NODE_HEIGHT / 2 - ARROW_OFFSET : to.y + NODE_HEIGHT / 2 + ARROW_OFFSET;
  } else {
    sx = dx > 0 ? from.x + NODE_WIDTH / 2 : from.x - NODE_WIDTH / 2;
    sy = from.y;
    ex = dx > 0 ? to.x - NODE_WIDTH / 2 - ARROW_OFFSET : to.x + NODE_WIDTH / 2 + ARROW_OFFSET;
    ey = to.y;
  }
  return `M ${sx} ${sy} L ${ex} ${ey}`;
}
```

## 生成约束与检查

- 布景先于揭示；页面初始就显示图题、首个必要对象和操作说明。节点 details 用文本，不把外部材料作为 HTML 插入。
- 使用当前 `course.css` 的色与字体；SVG 有 `viewBox`、可读标签、图题与文本替代说明。控件使用原生 button，键盘可操作。
- 定位只放外层 `g`；有意义的变色、揭示或缩放放内层。尊重减少动态效果偏好；不做自动循环动画。
- “下一步”“重置”由学习者点击；重置恢复所有状态和说明，不只改按钮文字。窄屏控件不覆盖图形。
- 如需附带答疑状态，用可见的 `p[data-teach-state]` 说明当前步骤、参数和已显示结果，外层标 `data-teach-context`；交给课程现有复制入口，不保存操作轨迹或未揭晓答案。
- 检查节点连接、箭头不穿文字、每步可读、重置有效、独立浏览器无网络仍可操作。图形操作本身不产生评估通过。
