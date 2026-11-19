import { ALL_CELLS, HILL_CELLS, PLAYERS, cellOf, getHillOwner, getRegion, isCell, keyOf } from "./engine.mjs";

const playersById = new Map(PLAYERS.map(player => [player.id, player]));
const unitAxes = [0, 1, 2];
const nearClip = 0.09;
const wallMargin = 0.16;
const movementSpeed = 3.65;
const moveDuration = 260;
const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]);
const hillTint = [245, 197, 105];
const center = 3.5;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function rgb(hex) {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}

function color(channels, alpha = 1) {
  return `rgba(${channels.map(Math.round).join(",")},${alpha})`;
}

function mix(a, b, ratio) {
  return a.map((channel, index) => channel + (b[index] - channel) * ratio);
}

function ring(radius, height, count) {
  return Array.from({ length: count }, (_, index) => {
    const angle = index / count * Math.PI * 2 - Math.PI / count;
    return [Math.cos(angle) * radius, height, Math.sin(angle) * radius];
  });
}

function lathe(profile, count = 6) {
  const rings = profile.map(([height, radius]) => ring(radius, height, count));
  const polygons = [rings[0].slice()];
  for (let level = 1; level < rings.length; level += 1) {
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      polygons.push([rings[level - 1][index], rings[level][index], rings[level][next], rings[level - 1][next]]);
    }
  }
  polygons.push(rings.at(-1).slice().reverse());
  return polygons;
}

function extrude(profile, depth) {
  const near = profile.map(([x, y]) => [x, y, depth / 2]);
  const far = profile.map(([x, y]) => [x, y, -depth / 2]);
  const polygons = [near.slice().reverse(), far];
  for (let index = 0; index < profile.length; index += 1) {
    const next = (index + 1) % profile.length;
    polygons.push([near[index], near[next], far[next], far[index]]);
  }
  return polygons;
}

function box(xMin, xMax, yMin, yMax, depth) {
  return extrude([[xMin, yMin], [xMin, yMax], [xMax, yMax], [xMax, yMin]], depth);
}

function crown(radius, inset, base, top, count, blankTop = 0) {
  const outer = ring(radius, base, count);
  const inner = ring(inset, base, count);
  const rim = outer.map(([x, , z], index) => [x, index % 2 ? top : top - blankTop, z]);
  const innerRim = inner.map(([x, , z], index) => [x, rim[index][1], z]);
  return outer.flatMap((point, index) => {
    const next = (index + 1) % count;
    return [
      [point, rim[index], rim[next], outer[next]],
      [inner[index], inner[next], innerRim[next], innerRim[index]],
      [rim[index], innerRim[index], rim[next]],
      [innerRim[index], innerRim[next], rim[next]]
    ];
  });
}

function turnPoint([x, y, z], angle) {
  return [x * Math.cos(angle) - z * Math.sin(angle), y, x * Math.sin(angle) + z * Math.cos(angle)];
}

const foundation = [[-0.37, 0.24], [-0.33, 0.31], [-0.27, 0.30], [-0.20, 0.21]];
const pawnFoundation = [[-0.34, 0.20], [-0.29, 0.27], [-0.235, 0.23]];
const knightProfile = [
  [-0.21, -0.17], [-0.265, 0.035], [-0.21, 0.23], [-0.085, 0.34],
  [-0.063, 0.42], [0.013, 0.39], [0.055, 0.31], [0.178, 0.26], [0.291, 0.137],
  [0.263, 0.042], [0.169, 0.035], [0.097, 0.105], [0.025, -0.015], [0.107, -0.17]
];
const rookTeeth = [0, 1, 2, 3].flatMap(side => {
  const tooth = box(-0.070, 0.070, 0.265, 0.39, 0.10);
  return tooth.map(face => face.map(([x, y, z]) => turnPoint([x, y, z - 0.183], Math.PI / 4 + side * Math.PI / 2)));
});

const models = {
  P: lathe([...pawnFoundation, [-0.10, 0.098], [0.026, 0.092], [0.058, 0.142],
    [0.126, 0.121], [0.187, 0.159], [0.270, 0.140], [0.323, 0.040]]),
  R: [
    ...lathe([...foundation, [-0.135, 0.20], [0.15, 0.178], [0.199, 0.261], [0.269, 0.261]]),
    ...rookTeeth
  ],
  B: lathe([...foundation, [-0.10, 0.122], [0.053, 0.095], [0.08, 0.214],
    [0.132, 0.18], [0.174, 0.124], [0.223, 0.167], [0.285, 0.135],
    [0.386, 0.046], [0.416, 0.018]]),
  N: [
    ...lathe([...foundation, [-0.164, 0.237], [-0.125, 0.208]]),
    ...extrude(knightProfile, 0.275)
  ],
  Q: [
    ...lathe([...foundation, [-0.14, 0.163], [0.035, 0.106], [0.112, 0.145],
      [0.143, 0.221], [0.208, 0.178], [0.245, 0.205]]),
    ...crown(0.242, 0.163, 0.219, 0.39, 10, 0.097)
  ],
  K: [
    ...lathe([...foundation, [-0.10, 0.139], [0.05, 0.114], [0.10, 0.22],
      [0.159, 0.194], [0.24, 0.115]]),
    ...box(-0.046, 0.046, 0.23, 0.466, 0.090),
    ...box(-0.139, 0.139, 0.33, 0.394, 0.074)
  ]
};

function normalOf(polygon) {
  const normal = [0, 0, 0];
  for (let index = 0; index < polygon.length; index += 1) {
    const [x, y, z] = polygon[index];
    const [nextX, nextY, nextZ] = polygon[(index + 1) % polygon.length];
    normal[0] += (y - nextY) * (z + nextZ);
    normal[1] += (z - nextZ) * (x + nextX);
    normal[2] += (x - nextX) * (y + nextY);
  }
  const length = Math.hypot(...normal);
  return normal.map(value => value / length);
}

function prepareMesh(polygons, angle, tint) {
  const positions = [];
  const indices = new Map();
  const faces = polygons.map(polygon => {
    const vertices = polygon.map(position => {
      const key = keyOf(position);
      if (!indices.has(key)) {
        indices.set(key, positions.length);
        positions.push(turnPoint(position, angle));
      }
      return indices.get(key);
    });
    const oriented = vertices.map(index => positions[index]);
    const normal = normalOf(oriented);
    const midpoint = unitAxes.map(axis => oriented.reduce((sum, point) => sum + point[axis], 0) / oriented.length);
    const light = Math.max(0, dot(normal, [-0.43, 0.76, -0.49]));
    const body = mix([15, 27, 22], tint, 0.39 + light * 0.59);
    return {
      vertices, normal, midpoint,
      plane: dot(normal, oriented[0]),
      fill: color(mix(body, [233, 250, 233], light ** 3 * 0.17))
    };
  });
  return { positions, faces };
}

// Heading belongs to the player, so an orbit reveals new sides of these fixed meshes.
const meshes = new Map(PLAYERS.map(player => {
  const heading = player.axis === 0 ? player.sign * Math.PI / 2 : (player.axis === 2 && player.sign > 0 ? Math.PI : 0);
  const tint = rgb(player.color);
  return [player.id, Object.fromEntries(Object.entries(models).map(([piece, model]) => [
    piece, prepareMesh(model, heading, tint)
  ]))];
}));

function planeCorners(origin, axis, radius) {
  const [u, v] = unitAxes.filter(other => other !== axis);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([du, dv]) => {
    const corner = [...origin];
    corner[u] += du * radius;
    corner[v] += dv * radius;
    return corner;
  });
}

function faceColor(region, axis, sign, parity) {
  const light = axis === 1 ? (sign > 0 ? 1 : 0.39) : (axis === 2 ? 0.82 : 0.65);
  const floor = parity ? [36, 54, 46] : [28, 43, 37];
  const base = mix([13, 22, 18], floor, light);
  if (region === "core") return color(base, 0.88);
  const faction = rgb(playersById.get(region).color);
  const outward = axis === playersById.get(region).axis && sign === playersById.get(region).sign;
  const saturation = (outward ? 0.18 : 0.11) * (parity ? 1 : 0.68);
  return color(mix(base, faction, saturation), 0.89);
}

function createFaces() {
  const faces = [];
  const byDirection = new Map();
  const vertices = new Map();

  for (let x = -4; x <= 11; x += 1) {
    for (let y = -4; y <= 11; y += 1) {
      for (let z = -4; z <= 11; z += 1) {
        const cell = [x, y, z];
        if (!isCell(cell)) continue;
        const region = getRegion(cell);
        for (const axis of unitAxes) {
          for (const sign of [-1, 1]) {
            const neighbor = [...cell];
            neighbor[axis] += sign;
            if (isCell(neighbor)) continue;
            const position = cell.map(value => value - center);
            position[axis] += sign * 0.5;
            const corners = planeCorners(position, axis, 0.5).map(corner => {
              const key = keyOf(corner);
              if (!vertices.has(key)) vertices.set(key, corner);
              return vertices.get(key);
            });
            const face = {
              cell, key: keyOf(cell), position, axis, sign, region, corners,
              fill: faceColor(region, axis, sign, (x + y + z) % 2 === 0),
              grid: region === "core" ? "rgba(133,183,156,.26)" : color(rgb(playersById.get(region).color), 0.28),
              border: region === "core" ? "rgba(148,204,172,.61)" : color(rgb(playersById.get(region).color), 0.57)
            };
            byDirection.set(`${face.key}:${axis}:${sign}`, face);
            faces.push(face);
          }
        }
      }
    }
  }

  for (const face of faces) {
    const [u, v] = unitAxes.filter(axis => axis !== face.axis);
    face.borderEdges = [[v, -1], [u, 1], [v, 1], [u, -1]].map(([axis, sign], index) => {
      const neighbor = [...face.cell];
      neighbor[axis] += sign;
      const adjacent = byDirection.get(`${keyOf(neighbor)}:${face.axis}:${face.sign}`);
      return adjacent?.region === face.region ? -1 : index;
    }).filter(index => index !== -1);
  }
  return faces;
}

const modelFaces = createFaces();

function createLayers() {
  return unitAxes.map(axis => {
    const layers = new Map();
    const [u, v] = unitAxes.filter(direction => direction !== axis);
    for (const cell of ALL_CELLS) {
      const position = cell.map(value => value - center);
      const region = getRegion(cell);
      const player = playersById.get(region);
      const base = [141, 232, 180];
      const hillOwner = getHillOwner(cell);
      const tint = player ? mix(base, rgb(player.color), 0.57) : base;
      const alternating = (cell[u] + cell[v]) % 2 === 0;
      const borders = [];
      const hillBorders = [];
      for (const [index, [direction, sign]] of [[v, -1], [u, 1], [v, 1], [u, -1]].entries()) {
        const neighbor = [...cell];
        neighbor[direction] += sign;
        if (!isCell(neighbor)) borders.push(index);
        if (hillOwner && getHillOwner(neighbor) !== hillOwner) hillBorders.push(index);
      }
      const depth = cell[axis];
      if (!layers.has(depth)) layers.set(depth, []);
      layers.get(depth).push({
        corners: planeCorners(position, axis, 0.5),
        styles: {
          borders,
          fill: color(tint, alternating ? 0.26 : 0.14),
          grid: color(tint, 0.54),
          edge: color(tint, 0.94)
        },
        hillOwner,
        hillStyles: hillOwner ? {
          borders: hillBorders,
          fill: color(hillTint, alternating ? 0.47 : 0.29),
          grid: color(hillTint, 0.75),
          edge: color(hillTint, 0.98)
        } : null
      });
    }
    return layers;
  });
}

const modelLayers = createLayers();

function includesCell(slice, cell) {
  return !slice || cell[slice.axis] === slice.depth;
}

function sameSlice(a, b) {
  return a?.axis === b?.axis && a?.depth === b?.depth;
}

function playerView(player, zoom = 1) {
  const eye = [0.09, 0.11, 0.07];
  eye[player.axis] = player.sign * 7.32;
  const yaw = player.axis === 0 ? -player.sign * Math.PI / 2 :
    (player.axis === 2 && player.sign > 0 ? Math.PI : 0);
  const pitch = player.axis === 1 ? -player.sign * 1.51 : -0.015;
  return { eye, yaw, pitch, zoom };
}

function centerView(player) {
  const yaw = player.axis === 0 ? player.sign * Math.PI / 2 :
    (player.axis === 2 && player.sign < 0 ? Math.PI : 0);
  const pitch = player.axis === 1 ? player.sign * Math.PI / 2 : 0;
  return { eye: [0, 0, 0], yaw, pitch, zoom: 1 };
}

function insideBoard(point) {
  const distances = point.map(Math.abs);
  if (distances.every(distance => distance <= 4)) return true;
  return distances.some((distance, axis) => distance <= 8 &&
    distances.every((other, direction) => direction === axis || other <= 2));
}

function canOccupy(point, width = wallMargin, height = wallMargin) {
  for (const x of [-width, width]) {
    for (const y of [-height, height]) {
      for (const z of [-width, width]) {
        if (!insideBoard([point[0] + x, point[1] + y, point[2] + z])) return false;
      }
    }
  }
  return true;
}

function animatedCell(move, progress, arc) {
  const cell = move.from.map((value, axis) => value + (move.to[axis] - value) * progress);
  cell[1] += Math.sin(progress * Math.PI) * arc;
  return cell;
}

function startAnimation(move) {
  let arc = 0;
  if (move.type === "N") {
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    arc = [0.24, -0.24].find(height => samples.every(progress => {
      const point = animatedCell(move, progress, height).map(value => value - center);
      return canOccupy(point, 0.31, 0.42);
    })) ?? 0;
  }
  return {
    move,
    arc,
    piece: { player: move.player, type: move.type },
    destination: keyOf(move.to),
    started: null,
    progress: 0
  };
}

function moveEye(eye, delta) {
  const steps = Math.max(1, Math.ceil(Math.hypot(...delta) / 0.16));
  const step = delta.map(value => value / steps);
  const result = [...eye];
  for (let index = 0; index < steps; index += 1) {
    for (const axis of unitAxes) {
      const candidate = [...result];
      candidate[axis] += step[axis];
      if (canOccupy(candidate)) result[axis] = candidate[axis];
    }
  }
  return result;
}

function camera(view, width, height) {
  const s = Math.sin(view.yaw);
  const c = Math.cos(view.yaw);
  const sinPitch = Math.sin(view.pitch);
  const cosPitch = Math.cos(view.pitch);
  const right = [c, 0, -s];
  const up = [-s * sinPitch, cosPitch, -c * sinPitch];
  const forward = [s * cosPitch, sinPitch, c * cosPitch];
  const eye = view.eye;
  const focalLength = height * 0.55 * view.zoom;
  const originX = width * 0.5;
  const originY = height * 0.5;

  function toCamera(point) {
    const offset = [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]];
    return [dot(offset, right), dot(offset, up), dot(offset, forward)];
  }

  function screen([x, y, z]) {
    const scale = focalLength / z;
    return { x: originX + x * scale, y: originY - y * scale, depth: -z, scale };
  }

  function nearIntersection(a, b) {
    const ratio = (nearClip - a[2]) / (b[2] - a[2]);
    return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio, nearClip];
  }

  function polygonCamera(points) {
    const clipped = [];
    let prior = points.at(-1);
    for (const current of points) {
      if ((current[2] >= nearClip) !== (prior[2] >= nearClip)) clipped.push(nearIntersection(prior, current));
      if (current[2] >= nearClip) clipped.push(current);
      prior = current;
    }
    if (clipped.length < 3) return [];
    const result = clipped.map(screen);
    if (result.every(point => point.x < 0) || result.every(point => point.x > width) ||
        result.every(point => point.y < 0) || result.every(point => point.y > height)) return [];
    return result;
  }

  return {
    eye, forward, originX, originY, polygonCamera, toCamera,
    depth(point) {
      return -toCamera(point)[2];
    },
    project(point) {
      const local = toCamera(point);
      return local[2] >= nearClip ? screen(local) : null;
    },
    polygon(points) {
      return polygonCamera(points.map(toCamera));
    },
    line(first, second) {
      const a = toCamera(first);
      const b = toCamera(second);
      if (a[2] < nearClip && b[2] < nearClip) return [];
      return [screen(a[2] < nearClip ? nearIntersection(a, b) : a),
        screen(b[2] < nearClip ? nearIntersection(a, b) : b)];
    },
    shows(axis, sign, point) {
      return sign * (eye[axis] - point[axis]) > 0;
    },
    ray(point) {
      const horizontal = (point.x - originX) / focalLength;
      const vertical = (originY - point.y) / focalLength;
      return forward.map((value, axis) => value + right[axis] * horizontal + up[axis] * vertical);
    }
  };
}

function path(ctx, points, closed = true) {
  ctx.beginPath();
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  if (closed) ctx.closePath();
}

function withinFace(point, surface) {
  if (point.x < surface.left || point.x > surface.right ||
      point.y < surface.top || point.y > surface.bottom) return false;
  let orientation = 0;
  for (let index = 0; index < surface.points.length; index += 1) {
    const a = surface.points[index];
    const b = surface.points[(index + 1) % surface.points.length];
    const side = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(side) < 0.01) continue;
    if (orientation && orientation !== Math.sign(side)) return false;
    orientation = Math.sign(side);
  }
  return true;
}

function polygonBounds(points) {
  return {
    points,
    left: Math.min(...points.map(point => point.x)),
    right: Math.max(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)),
    bottom: Math.max(...points.map(point => point.y))
  };
}

function drawGround(ctx, width, height) {
  const glow = ctx.createRadialGradient(width * 0.5, height * 0.43, 6,
    width * 0.5, height * 0.43, Math.min(width, height) * 0.78);
  glow.addColorStop(0, "rgba(52,88,66,.39)");
  glow.addColorStop(1, "rgba(14,21,18,.08)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
}

function drawSurfaces(ctx, projection) {
  const surfaces = [];
  for (const face of modelFaces) {
    if (projection.shows(face.axis, face.sign, face.position)) continue;
    const points = projection.polygon(face.corners);
    if (points.length < 3) continue;
    surfaces.push({ face, depth: projection.depth(face.position), ...polygonBounds(points) });
  }

  surfaces.sort((a, b) => a.depth - b.depth);
  for (const { face, points } of surfaces) {
    path(ctx, points);
    ctx.fillStyle = face.fill;
    ctx.fill();
    ctx.lineWidth = 0.76;
    ctx.strokeStyle = face.grid;
    ctx.stroke();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = face.border;
    for (const index of face.borderEdges) {
      const edge = projection.line(face.corners[index], face.corners[(index + 1) % 4]);
      if (!edge.length) continue;
      path(ctx, edge, false);
      ctx.stroke();
    }
  }
  return surfaces;
}

const hillModels = PLAYERS.map(player => {
  const cells = HILL_CELLS.filter(cell => getHillOwner(cell) === player.id);
  const midpoint = unitAxes.map(axis =>
    cells.reduce((sum, cell) => sum + cell[axis] - center, 0) / cells.length);
  const inward = [...midpoint];
  inward[player.axis] -= player.sign * 0.5;
  const faces = cells.flatMap(cell => unitAxes.flatMap(axis => [-1, 1].flatMap(sign => {
    const neighbor = [...cell];
    neighbor[axis] += sign;
    if (getHillOwner(neighbor) === player.id) return [];
    const position = cell.map(value => value - center);
    position[axis] += sign * 0.5;
    return [{ axis, sign, position, corners: planeCorners(position, axis, 0.5) }];
  })));
  return {
    player, midpoint, faces,
    inwardCorners: planeCorners(inward, player.axis, 1),
    accent: rgb(player.color),
    faceTint: mix(hillTint, rgb(player.color), 0.17)
  };
});

function drawHills(ctx, projection, eliminated) {
  const visible = hillModels.flatMap(hill => hill.faces.map(face => ({
    hill, face, depth: projection.depth(face.position)
  }))).sort((a, b) => a.depth - b.depth);
  for (const { hill, face } of visible) {
    const points = projection.polygon(face.corners);
    if (points.length < 3) continue;
    const active = !eliminated.has(hill.player.id);
    const front = projection.shows(face.axis, face.sign, face.position);
    const entryFace = face.axis === hill.player.axis && face.sign === -hill.player.sign;
    path(ctx, points);
    if (active) {
      ctx.fillStyle = color(hill.faceTint, front ? (entryFace ? 0.24 : 0.13) : 0.035);
      ctx.fill();
    }
    ctx.strokeStyle = active
      ? color(hillTint, front ? (entryFace ? 0.9 : 0.63) : 0.23)
      : color(hill.accent, front ? 0.22 : 0.08);
    ctx.lineWidth = active && front ? 1.6 : 0.74;
    ctx.stroke();
  }
}

function drawSlice(ctx, projection, slice, eliminated) {
  for (const tile of modelLayers[slice.axis].get(slice.depth) ?? []) {
    const points = projection.polygon(tile.corners);
    if (points.length < 3) continue;
    const styles = tile.hillOwner && !eliminated.has(tile.hillOwner) ? tile.hillStyles : tile.styles;
    path(ctx, points);
    ctx.fillStyle = styles.fill;
    ctx.fill();
    ctx.lineWidth = 0.78;
    ctx.strokeStyle = styles.grid;
    ctx.stroke();
    ctx.lineWidth = 1.65;
    ctx.strokeStyle = styles.edge;
    for (const index of styles.borders) {
      const edge = projection.line(tile.corners[index], tile.corners[(index + 1) % 4]);
      if (!edge.length) continue;
      path(ctx, edge, false);
      ctx.stroke();
    }
  }
}

function drawCellOutline(ctx, projection, cell, tint, opacity) {
  const position = cell.map(value => value - center);
  for (const axis of unitAxes) {
    for (const sign of [-1, 1]) {
      const face = [...position];
      face[axis] += sign * 0.48;
      if (!projection.shows(axis, sign, face)) continue;
      const points = projection.polygon(planeCorners(face, axis, 0.48));
      if (points.length < 3) continue;
      path(ctx, points);
      ctx.fillStyle = color(tint, opacity * 0.11);
      ctx.fill();
      ctx.lineWidth = 1.18;
      ctx.strokeStyle = color(tint, opacity);
      ctx.stroke();
    }
  }
}

function drawPiece(ctx, projection, piece, cell, opacity) {
  const mesh = meshes.get(piece.player)[piece.type];
  const origin = cell.map(value => value - center);
  if (projection.depth(origin) > 0.63) return;
  const cameraRelative = projection.eye.map((value, axis) => value - origin[axis]);
  const vertices = mesh.positions.map(([x, y, z]) => projection.toCamera([origin[0] + x, origin[1] + y, origin[2] + z]));
  const visible = mesh.faces
    .filter(face => dot(face.normal, cameraRelative) > face.plane)
    .map(face => ({ face, depth: dot(face.midpoint, projection.forward) }))
    .sort((a, b) => b.depth - a.depth);

  ctx.globalAlpha = opacity;
  for (const { face } of visible) {
    const points = projection.polygonCamera(face.vertices.map(index => vertices[index]));
    if (points.length < 3) continue;
    path(ctx, points);
    ctx.fillStyle = face.fill;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawHillLabels(ctx, projection, active, width, height, eliminated) {
  const fontSize = width > 510 ? 9 : 8;
  const occupied = [];
  const labels = hillModels
    .filter(hill => !eliminated.has(hill.player.id))
    .map(hill => ({ hill, point: projection.project(hill.midpoint) }))
    .filter(({ point }) => point && point.scale < 280 && point.x > 18 && point.x < width - 18 &&
      point.y > 14 && point.y < height - 14)
    .sort((a, b) => b.point.depth - a.point.depth);

  ctx.font = `600 ${fontSize}px "IBM Plex Mono", "Courier New", monospace`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const { hill, point } of labels) {
    const corners = projection.polygon(hill.inwardCorners);
    if (!corners.length) continue;
    const label = `${hill.player.name.toUpperCase()} HILL`;
    const length = ctx.measureText(label).width + 22;
    const x = clamp(point.x, length / 2 + 10, width - length / 2 - 10);
    const edgeY = Math.min(...corners.map(corner => corner.y));
    let y = clamp(edgeY - 13, 13, height - 13);
    for (const earlier of occupied) {
      if (Math.abs(x - earlier.x) < (length + earlier.length) / 2 + 5 && Math.abs(y - earlier.y) < 17) {
        y = clamp(earlier.y + 18, 13, height - 13);
      }
    }
    occupied.push({ x, y, length });
    const current = hill.player.id === active;
    ctx.beginPath();
    ctx.roundRect(x - length / 2, y - 8, length, 16, 3);
    ctx.fillStyle = color(mix([17, 25, 20], hill.accent, 0.11), 0.95);
    ctx.fill();
    ctx.strokeStyle = color(hillTint, current ? 0.72 : 0.49);
    ctx.lineWidth = 0.85;
    ctx.stroke();
    const marker = x - length / 2 + 7;
    path(ctx, [{ x: marker, y: y - 2.3 }, { x: marker + 2.3, y },
      { x: marker, y: y + 2.3 }, { x: marker - 2.3, y }]);
    ctx.fillStyle = color(hillTint, 0.93);
    ctx.fill();
    ctx.fillStyle = color(mix(hill.accent, [250, 255, 246], 0.58), 0.93);
    ctx.fillText(label, x - length / 2 + 13, y + 0.35);
  }
}

function cellPoint(projection, cell) {
  return projection.project(cell.map(value => value - center));
}

function lastArmyMoves(log) {
  const latest = new Map();
  for (let index = log.length - 1; index >= 0 && latest.size < PLAYERS.length; index -= 1) {
    const move = log[index];
    if (!move || !playersById.has(move.player) || latest.has(move.player)) continue;
    if (isCell(move.from) && isCell(move.to)) latest.set(move.player, move);
  }
  return [...latest.values()];
}

function markerEdges(position, radius, slice) {
  if (slice) {
    const corners = planeCorners(position, slice.axis, radius);
    return corners.map((corner, index) => [corner, corners[(index + 1) % corners.length]]);
  }

  return unitAxes.flatMap(axis => {
    const [u, v] = unitAxes.filter(direction => direction !== axis);
    return [-1, 1].flatMap(first => [-1, 1].map(second => {
      const start = [...position];
      start[axis] -= radius;
      start[u] += first * radius;
      start[v] += second * radius;
      const end = [...start];
      end[axis] += radius * 2;
      return [start, end];
    }));
  });
}

function drawMoveHistory(ctx, projection, slice, lastMoves, animation, eliminated, primaryCells) {
  const used = new Map();
  for (const move of lastMoves) {
    const tint = rgb(playersById.get(move.player).color);
    const endpoints = [[move.from, false]];
    if (move !== animation?.move) endpoints.push([move.to, true]);
    for (const [cell, landing] of endpoints) {
      if (!includesCell(slice, cell)) continue;
      const key = keyOf(cell);
      const stack = used.get(key) ?? { origin: 0, landing: 0 };
      const group = landing ? "landing" : "origin";
      const offset = stack[group];
      stack[group] += 1;
      used.set(key, stack);

      const radius = (landing ? 0.44 : 0.32) - offset * 0.033;
      const emphasis = primaryCells.has(key) ? 0.53 : (getHillOwner(cell) ? 0.78 : 1);
      const active = eliminated.has(move.player) ? 0.58 : 1;
      ctx.strokeStyle = color(tint, (landing ? 0.65 : 0.39) * active * emphasis);
      ctx.lineWidth = landing ? 1.45 : 0.95;
      ctx.setLineDash?.(landing ? [] : [2.5, 3]);
      ctx.beginPath();
      for (const [from, to] of markerEdges(cell.map(value => value - center), radius, slice)) {
        const segments = landing ? [
          [from, from.map((value, axis) => value + (to[axis] - value) * 0.22)],
          [to, to.map((value, axis) => value + (from[axis] - value) * 0.22)]
        ] : [[from, to]];
        for (const [start, end] of segments) {
          const points = projection.line(start, end);
          if (!points.length) continue;
          ctx.moveTo(points[0].x, points[0].y);
          ctx.lineTo(points[1].x, points[1].y);
        }
      }
      ctx.stroke();
      ctx.setLineDash?.([]);
    }
  }
}

function drawTokens(ctx, projection, surfaces, state, hover, eliminated, animation, lastMoves) {
  const { game, selection, slice } = state;
  const moves = state.moves.filter(move =>
    includesCell(slice, move.to) && keyOf(move.to) !== animation?.destination);
  const targets = [];
  const hoveredKey = hover ? keyOf(hover) : null;
  const selectedKey = selection ? keyOf(selection) : null;
  const kingSelected = game.board[selectedKey]?.type === "K";
  const moveKeys = new Set(moves.map(move => keyOf(move.to)));
  const pieces = Object.entries(game.board).flatMap(([key, piece]) => key === animation?.destination ?
    [] : [{ key, cell: cellOf(key), piece, opacity: 1 }]);
  if (animation) {
    const { move, arc, progress, piece } = animation;
    const eased = progress * progress * (3 - 2 * progress);
    const cell = animatedCell(move, eased, arc);
    pieces.push({ key: null, cell, piece, opacity: 1 });
    if (move.capture) {
      pieces.push({ key: null, cell: move.to, piece: move.capture, opacity: clamp((1 - progress) / 0.4, 0, 1) });
    }
  }
  const projected = pieces.map(({ key, cell, piece, opacity }) => {
    const point = cellPoint(projection, cell);
    const depth = projection.depth(cell.map(value => value - center));
    const onSlice = !slice || Math.abs(cell[slice.axis] - slice.depth) < 0.5;
    return { key, cell, piece, opacity, point, depth, onSlice };
  }).sort((a, b) => a.depth - b.depth);

  if (slice) {
    for (const { cell, piece, opacity, onSlice } of projected) {
      if (!onSlice) drawPiece(ctx, projection, piece, cell, 0.17 * opacity);
    }
    drawSlice(ctx, projection, slice, eliminated);
  }

  if (hover && !game.board[hoveredKey] && !moveKeys.has(hoveredKey)) {
    drawCellOutline(ctx, projection, hover, [146, 206, 177], 0.46);
  }
  const movementTint = rgb(playersById.get(game.turn)?.color ?? "#72e0ab");
  if (selection && includesCell(slice, selection) && moves.length === 1) {
    const line = projection.line(selection.map(value => value - center), moves[0].to.map(value => value - center));
    path(ctx, line, false);
    ctx.strokeStyle = color(movementTint, 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (const { key, cell, piece, opacity, point, onSlice } of projected) {
    if (!onSlice) continue;
    const player = playersById.get(piece.player);
    const active = player.id === game.turn;
    const selected = key !== null && key === selectedKey;
    const hovered = key !== null && key === hoveredKey;
    const bright = key === null || selected || hovered || (active && !selection);
    const hidden = !slice && !bright && point && surfaces.some(surface => surface.depth > point.depth + 0.64 &&
      surface.face.key !== key && withinFace(point, surface));
    const tint = rgb(player.color);
    const lighting = bright ? 1 : (hidden ? 0.43 : (active ? 0.95 : 0.84));
    if (selected || hovered) drawCellOutline(ctx, projection, cell, tint, selected ? 0.81 : 0.52);
    drawPiece(ctx, projection, piece, cell, opacity * lighting);
    if (key !== null) targets.push({ cell, move: false });
  }

  const primaryCells = new Set([...moveKeys, selectedKey, hoveredKey]);
  drawMoveHistory(ctx, projection, slice, lastMoves, animation, eliminated, primaryCells);

  for (const move of moves) {
    const point = cellPoint(projection, move.to);
    if (!point) continue;
    const highlighted = keyOf(move.to) === hoveredKey;
    const hillOwner = getHillOwner(move.to);
    const claimsHill = kingSelected && hillOwner && hillOwner !== game.turn && !eliminated.has(hillOwner);
    const tint = claimsHill ? hillTint : move.capture ? [249, 145, 135] : movementTint;
    if (highlighted || moves.length === 1) {
      drawCellOutline(ctx, projection, move.to, tint, highlighted ? 0.84 : 0.54);
    }
    const radius = clamp(point.scale * (move.capture ? 0.4 : 0.17), claimsHill ? 7 : 4, 13);
    if (claimsHill) {
      path(ctx, [{ x: point.x, y: point.y - radius }, { x: point.x + radius, y: point.y },
        { x: point.x, y: point.y + radius }, { x: point.x - radius, y: point.y }]);
    } else {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    }
    if (!move.capture || claimsHill) {
      ctx.fillStyle = color(tint, highlighted ? 0.55 : (claimsHill ? 0.45 : 0.26));
      ctx.fill();
    }
    ctx.strokeStyle = color(tint, highlighted ? 1 : 0.86);
    ctx.lineWidth = move.capture || claimsHill ? 1.65 : 1.15;
    ctx.stroke();
    if (!move.capture && !claimsHill) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, highlighted ? 2.5 : 1.55, 0, Math.PI * 2);
      ctx.fillStyle = color(tint, 0.94);
      ctx.fill();
    }
    targets.push({ point, radius: Math.max(radius, 8), cell: move.to, move: true });
  }
  return targets;
}

function rayPiece(eye, ray, cell) {
  let entry = -Infinity;
  let exit = Infinity;
  const bounds = [0.34, 0.47, 0.34];
  for (const axis of unitAxes) {
    const midpoint = cell[axis] - center;
    const low = midpoint - bounds[axis] - eye[axis];
    const high = midpoint + bounds[axis] - eye[axis];
    if (Math.abs(ray[axis]) < 0.000001) {
      if (low > 0 || high < 0) return Infinity;
      continue;
    }
    const distances = [low / ray[axis], high / ray[axis]];
    entry = Math.max(entry, Math.min(...distances));
    exit = Math.min(exit, Math.max(...distances));
  }
  return entry >= 0 && Math.max(entry, nearClip) <= exit ? Math.max(entry, nearClip) : Infinity;
}

export function createVolume(canvas, {
  onCell = () => {}, onHover = () => {}, getSpawnArmy = () => PLAYERS[0].id
} = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return {
    render() {}, reset() {}, rotate() {}, zoom() {}, focusPlayer() {}, focusHill() {}, setMovement() {}, destroy() {}
  };
  let view = centerView(playersById.get(getSpawnArmy()) ?? PLAYERS[0]);
  const pointers = new Map();
  const held = new Set();
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const controller = new AbortController();
  const events = { signal: controller.signal };
  let state = null;
  let surfaces = [];
  let targets = [];
  let projection = null;
  let animation = null;
  let lastMoves = [];
  let paintedGame = null;
  let paintedSlice = null;
  let hover = null;
  let drawFrame = 0;
  let lastMoveTime = null;
  let needsPaint = true;
  let lastPinch = 0;
  let justDragged = false;
  canvas.style.touchAction = "none";

  function paint() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width < 1 || height < 1) return;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * density);
    const pixelHeight = Math.round(height * density);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(density, 0, 0, density, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    projection = camera(view, width, height);
    paintedGame = state?.game ?? null;
    paintedSlice = state?.slice ?? null;
    drawGround(ctx, width, height);
    ctx.globalAlpha = paintedSlice ? 0.58 : 1;
    surfaces = drawSurfaces(ctx, projection);
    const eliminated = new Set(state?.game.eliminated ?? []);
    ctx.globalAlpha = paintedSlice ? 0.43 : 1;
    drawHills(ctx, projection, eliminated);
    ctx.globalAlpha = 1;
    if (!state) return;
    targets = drawTokens(ctx, projection, surfaces, state, hover, eliminated, animation, lastMoves);
    drawHillLabels(ctx, projection, state.game.turn, width, height, eliminated);
  }

  function requestFrame() {
    if (drawFrame) return;
    drawFrame = requestAnimationFrame(time => {
      drawFrame = 0;
      if (held.size) {
        const seconds = lastMoveTime === null ? 1 / 60 : clamp((time - lastMoveTime) / 1000, 0, 0.055);
        lastMoveTime = time;
        const strafe = Number(held.has("KeyD")) - Number(held.has("KeyA"));
        const advance = Number(held.has("KeyW")) - Number(held.has("KeyS"));
        const rise = Number(held.has("Space")) - Number(held.has("ShiftLeft") || held.has("ShiftRight"));
        const magnitude = Math.hypot(strafe, advance, rise);
        if (magnitude) {
          const pace = movementSpeed * seconds / magnitude;
          const x = Math.cos(view.yaw) * strafe + Math.sin(view.yaw) * advance;
          const z = -Math.sin(view.yaw) * strafe + Math.cos(view.yaw) * advance;
          const next = moveEye(view.eye, [x * pace, rise * pace, z * pace]);
          if (next.some((value, axis) => value !== view.eye[axis])) needsPaint = true;
          view.eye = next;
        }
      }
      if (animation) {
        animation.started ??= time;
        animation.progress = clamp((time - animation.started) / moveDuration, 0, 1);
        if (animation.progress >= 1 || reducedMotion?.matches) animation = null;
        needsPaint = true;
      }
      if (needsPaint) {
        needsPaint = false;
        paint();
      }
      if (held.size || animation) requestFrame();
    });
  }

  function schedule() {
    needsPaint = true;
    requestFrame();
  }

  function pick(event) {
    if (!projection || paintedGame !== state?.game || !sameSlice(paintedSlice, state?.slice)) return null;
    const bounds = canvas.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const ray = projection.ray(point);
    let bestMove = null;
    let moveDistance = Infinity;
    for (const target of targets) {
      if (!target.move) continue;
      const distance = Math.hypot(point.x - target.point.x, point.y - target.point.y);
      const threshold = Math.max(target.radius, event.pointerType === "touch" ? 13 : 8);
      if (distance <= threshold && distance < moveDistance) {
        moveDistance = distance;
        bestMove = target.cell;
      }
    }
    if (bestMove) return bestMove;

    const eye = projection.eye;
    let bestCell = null;
    let cellDistance = Infinity;
    for (const target of targets) {
      if (target.move) continue;
      const distance = rayPiece(eye, ray, target.cell);
      if (distance < cellDistance) {
        cellDistance = distance;
        bestCell = target.cell;
      }
    }
    if (bestCell) return bestCell;

    if (paintedSlice) {
      const { axis, depth } = paintedSlice;
      const distance = (depth - center - eye[axis]) / ray[axis];
      if (!Number.isFinite(distance) || distance < nearClip) return null;
      const cell = eye.map((value, direction) => Math.floor(value + ray[direction] * distance + 4));
      cell[axis] = depth;
      return isCell(cell) && keyOf(cell) !== animation?.destination ? cell : null;
    }

    for (const surface of surfaces) {
      if (!withinFace(point, surface)) continue;
      const { face } = surface;
      const distance = (face.position[face.axis] - eye[face.axis]) / ray[face.axis];
      if (distance >= nearClip && distance < cellDistance) {
        cellDistance = distance;
        bestCell = face.cell;
      }
    }
    return bestCell && keyOf(bestCell) !== animation?.destination ? bestCell : null;
  }

  function setHover(cell) {
    if ((!cell && !hover) || (cell && hover && keyOf(cell) === keyOf(hover))) return;
    hover = cell;
    onHover(hover);
    schedule();
  }

  function clearMovement() {
    held.clear();
    lastMoveTime = null;
  }

  function setMovement(code, pressed) {
    if (!movementKeys.has(code)) return;
    if (pressed) {
      held.add(code);
      setHover(null);
      requestFrame();
    } else {
      held.delete(code);
      if (!held.size) lastMoveTime = null;
    }
  }

  function changeView(next) {
    clearMovement();
    view = next;
    projection = null;
    setHover(null);
    schedule();
  }

  function reset(playerId = getSpawnArmy()) {
    changeView(centerView(playersById.get(playerId) ?? PLAYERS[0]));
  }

  function rotate(dx, dy) {
    view.yaw += dx;
    view.pitch = clamp(view.pitch + dy, -Math.PI / 2, Math.PI / 2);
    schedule();
  }

  function zoom(factor) {
    view.zoom = clamp(view.zoom * factor, 0.67, 1.85);
    schedule();
  }

  function focusPlayer(id) {
    const player = playersById.get(id);
    if (player) changeView(playerView(player, view.zoom));
  }

  function focusHill(playerId) {
    const hill = hillModels.find(candidate => candidate.player.id === playerId);
    if (!hill) return;
    const { axis, sign } = hill.player;
    const lateral = unitAxes.filter(direction => direction !== axis);
    const eye = [...hill.midpoint];
    eye[axis] -= sign * 2.84;
    eye[lateral[0]] += 0.43;
    eye[lateral[1]] += 0.57;
    const [x, y, z] = hill.midpoint.map((value, direction) => value - eye[direction]);
    changeView({ eye, yaw: Math.atan2(x, z), pitch: Math.atan2(y, Math.hypot(x, z)), zoom: 1 });
  }

  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY });
    if (pointers.size === 1) {
      justDragged = false;
      canvas.style.cursor = "grabbing";
    } else {
      justDragged = true;
      lastPinch = 0;
    }
  }, events);

  canvas.addEventListener("pointermove", event => {
    const prior = pointers.get(event.pointerId);
    if (!prior) {
      if (event.pointerType !== "touch") {
        const cell = pick(event);
        setHover(cell);
        canvas.style.cursor = cell ? "pointer" : "grab";
      }
      return;
    }
    const dx = event.clientX - prior.x;
    const dy = event.clientY - prior.y;
    prior.x = event.clientX;
    prior.y = event.clientY;
    if (pointers.size > 1) {
      const [a, b] = pointers.values();
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch > 0 && distance > 0) zoom(distance / lastPinch);
      lastPinch = distance;
      return;
    }
    if (!justDragged && Math.hypot(prior.x - prior.originX, prior.y - prior.originY) < 4) return;
    justDragged = true;
    setHover(null);
    rotate(dx * 0.006, -dy * 0.006);
  }, events);

  canvas.addEventListener("pointerup", event => {
    if (!pointers.delete(event.pointerId)) return;
    canvas.style.cursor = "grab";
    if (event.pointerType === "touch") setHover(null);
    if (justDragged) return;
    const cell = pick(event);
    if (cell) onCell(cell);
  }, events);

  canvas.addEventListener("pointercancel", event => {
    pointers.delete(event.pointerId);
    canvas.style.cursor = "grab";
    setHover(null);
  }, events);
  canvas.addEventListener("pointerleave", () => setHover(null), events);
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    zoom(Math.exp(-clamp(event.deltaY, -100, 100) * 0.0032));
  }, { ...events, passive: false });
  canvas.addEventListener("keydown", event => {
    if (movementKeys.has(event.code) && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      setMovement(event.code, true);
      return;
    }
    const actions = {
      ArrowLeft: () => rotate(-0.18, 0),
      ArrowRight: () => rotate(0.18, 0),
      ArrowUp: () => rotate(0, 0.18),
      ArrowDown: () => rotate(0, -0.18),
      "+": () => zoom(1.15),
      "=": () => zoom(1.15),
      "-": () => zoom(1 / 1.15),
      Home: reset
    };
    if (!actions[event.key]) return;
    event.preventDefault();
    actions[event.key]();
  }, events);

  canvas.addEventListener("blur", clearMovement, events);
  window.addEventListener?.("keyup", event => setMovement(event.code, false), events);
  window.addEventListener?.("blur", clearMovement, events);

  const observer = new ResizeObserver(schedule);
  observer.observe(canvas);
  schedule();

  return {
    render(nextState) {
      const sliceChanged = !sameSlice(state?.slice, nextState.slice);
      const previousGame = state?.game;
      const { game, move } = nextState;
      const gameChanged = previousGame !== game;
      if (gameChanged) {
        const freshMove = move && move === game.log.at(-1) && previousGame &&
          game.log.length === previousGame.log.length + 1 && game.log.at(-2) === previousGame.log.at(-1);
        animation = freshMove && !reducedMotion?.matches ? startAnimation(move) : null;
      }
      state = nextState;
      lastMoves = lastArmyMoves(game.log);
      if (sliceChanged || gameChanged) setHover(null);
      schedule();
    },
    reset,
    rotate,
    zoom,
    focusPlayer,
    focusHill,
    setMovement,
    destroy() {
      clearMovement();
      if (drawFrame) cancelAnimationFrame(drawFrame);
      controller.abort();
      observer.disconnect();
    }
  };
}
