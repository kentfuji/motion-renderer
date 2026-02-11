import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const t2mBaseChain = [
  [0, 2, 5, 8, 11],
  [0, 1, 4, 7, 10],
  [0, 3, 6, 9, 12, 15],
  [9, 14, 17, 19, 21],
  [9, 13, 16, 18, 20],
];

const t2mLeftHandChain = [
  [20, 22, 23, 24],
  [20, 34, 35, 36],
  [20, 25, 26, 27],
  [20, 31, 32, 33],
  [20, 28, 29, 30],
];

const t2mRightHandChain = [
  [21, 43, 44, 45],
  [21, 46, 47, 48],
  [21, 40, 41, 42],
  [21, 37, 38, 39],
  [21, 49, 50, 51],
];

const t2mRawOffsets = [
  [0, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0, 0, 1],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, -1, 0],
  [0, -1, 0],
  [0, -1, 0],
  [0, -1, 0],
  [0, -1, 0],
  [0, -1, 0],
];

const colors = [
  "#2f6bdb", // right leg
  "#4fb0c6", // left leg
  "#d64a3a", // spine / torso
  "#58b15e", // right arm
  "#f0a53a", // left arm
  "#2f6bdb",
  "#2f6bdb",
  "#2f6bdb",
  "#2f6bdb",
  "#2f6bdb",
  "#4fb0c6",
  "#4fb0c6",
  "#4fb0c6",
  "#4fb0c6",
  "#4fb0c6",
];

const state = {
  fps: 30,
  playing: false,
  frame: 0,
  frames: [],
  joints: 0,
  maxFrames: 0,
  min: new THREE.Vector3(),
  max: new THREE.Vector3(),
  heightOffset: 0,
  trajec: [],
  source: "idle",
  recording: false,
  frameAccumulator: 0,
  lastTime: 0,
};

const canvas = document.getElementById("canvas");
const playPause = document.getElementById("playPause");
const jointsFile = document.getElementById("jointsFile");
const ricFile = document.getElementById("ricFile");
const npyFile = document.getElementById("npyFile");
const recordBtn = document.getElementById("recordBtn");
const fpsInput = document.getElementById("fpsInput");
const frameScrub = document.getElementById("frameScrub");
const status = document.getElementById("status");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const ambient = new THREE.AmbientLight(0xffffff, 0.6);
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(3, 5, 4);
scene.add(ambient, dir);

const skeletonGroup = new THREE.Group();
scene.add(skeletonGroup);

const trajectoryLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: "#4fb0c6" })
);
scene.add(trajectoryLine);

const planeGeometry = new THREE.BufferGeometry();
const planePositions = new Float32Array(12);
planeGeometry.setAttribute("position", new THREE.BufferAttribute(planePositions, 3));
planeGeometry.setIndex([0, 1, 2, 0, 2, 3]);
planeGeometry.computeVertexNormals();
const planeMaterial = new THREE.MeshStandardMaterial({
  color: 0x808080,
  transparent: true,
  opacity: 0.4,
  side: THREE.DoubleSide,
});
const plane = new THREE.Mesh(planeGeometry, planeMaterial);
scene.add(plane);

let jointMeshes = [];
let boneMeshes = [];
let bonePairs = [];

function setCameraDefault() {
  const radius = 7.5;
  const elev = THREE.MathUtils.degToRad(120);
  const azim = THREE.MathUtils.degToRad(-90);
  const y = radius * Math.sin(elev);
  const proj = radius * Math.cos(elev);
  const x = proj * Math.cos(azim);
  const z = proj * Math.sin(azim);
  camera.position.set(x, y, z);
  camera.lookAt(0, 1, 0);
  controls.target.set(0, 1, 0);
  controls.update();
}

function resize() {
  const { clientWidth, clientHeight } = canvas;
  if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }
}

function computeStats(frames) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const frame of frames) {
    for (const joint of frame) {
      min.min(new THREE.Vector3(joint[0], joint[1], joint[2]));
      max.max(new THREE.Vector3(joint[0], joint[1], joint[2]));
    }
  }
  state.min.copy(min);
  state.max.copy(max);
  state.heightOffset = min.y;
}

function preprocessFrames(frames) {
  computeStats(frames);
  const normalized = frames.map((frame, idx) => {
    const out = frame.map((joint) => [joint[0], joint[1], joint[2]]);
    for (const joint of out) {
      joint[1] -= state.heightOffset;
    }
    return out;
  });

  const trajec = normalized.map((frame) => [frame[0][0], frame[0][2]]);
  for (let i = 0; i < normalized.length; i += 1) {
    const rootX = normalized[i][0][0];
    const rootZ = normalized[i][0][2];
    for (const joint of normalized[i]) {
      joint[0] -= rootX;
      joint[2] -= rootZ;
    }
  }

  state.trajec = trajec;
  return normalized;
}

function buildSkeletonMeshes() {
  jointMeshes.forEach((mesh) => {
    mesh.geometry.dispose();
    mesh.material.dispose();
    skeletonGroup.remove(mesh);
  });
  boneMeshes.forEach((mesh) => {
    mesh.geometry.dispose();
    mesh.material.dispose();
    skeletonGroup.remove(mesh);
  });
  jointMeshes = [];
  boneMeshes = [];
  bonePairs = [];

  const chains = [...t2mBaseChain];
  if (state.joints > 22) {
    chains.push(...t2mLeftHandChain, ...t2mRightHandChain);
  }

  const jointColorMap = new Array(state.joints).fill("#d7dee8");
  const chainCount = Math.min(chains.length, colors.length);
  for (let i = 0; i < chainCount; i += 1) {
    const chain = chains[i];
    for (const jointIdx of chain) {
      if (jointIdx < jointColorMap.length) {
        jointColorMap[jointIdx] = colors[i];
      }
    }
  }
  // Force all spine joints to use spine color.
  const spineColor = colors[2];
  const spineJoints = [0, 3, 6, 9, 12, 15];
  for (const jointIdx of spineJoints) {
    if (jointIdx < jointColorMap.length) {
      jointColorMap[jointIdx] = spineColor;
    }
  }

  const sphereGeometry = new THREE.SphereGeometry(0.06, 16, 16);
  for (let i = 0; i < state.joints; i += 1) {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(jointColorMap[i]),
      roughness: 0.35,
      metalness: 0.1,
    });
    const sphere = new THREE.Mesh(sphereGeometry, material);
    skeletonGroup.add(sphere);
    jointMeshes.push(sphere);
  }

  const cylinderGeometry = new THREE.CylinderGeometry(0.03, 0.03, 1, 12);
  for (let i = 0; i < chainCount; i += 1) {
    const chain = chains[i];
    for (let j = 0; j < chain.length - 1; j += 1) {
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(colors[i]),
        roughness: 0.35,
        metalness: 0.05,
      });
      const bone = new THREE.Mesh(cylinderGeometry, material);
      skeletonGroup.add(bone);
      boneMeshes.push(bone);
      bonePairs.push([chain[j], chain[j + 1]]);
    }
  }
}

function updateSkeleton(frameIndex) {
  const frame = state.frames[frameIndex];
  if (!frame) return;

  const traj = state.trajec[frameIndex] || [0, 0];
  updatePlane(frameIndex, traj);
  updateTrajectory(frameIndex, traj);

  for (let i = 0; i < jointMeshes.length; i += 1) {
    const joint = frame[i] || [0, 0, 0];
    jointMeshes[i].position.set(joint[0], joint[1], joint[2]);
  }

  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < boneMeshes.length; i += 1) {
    const [aIdx, bIdx] = bonePairs[i];
    const a = frame[aIdx] || [0, 0, 0];
    const b = frame[bIdx] || [0, 0, 0];
    const start = new THREE.Vector3(a[0], a[1], a[2]);
    const end = new THREE.Vector3(b[0], b[1], b[2]);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    const dir = end.clone().sub(start);
    const length = dir.length();
    if (length < 1e-6) continue;
    dir.normalize();
    const bone = boneMeshes[i];
    bone.position.copy(mid);
    bone.scale.set(1, length, 1);
    bone.quaternion.setFromUnitVectors(up, dir);
  }
}

function updatePlane(frameIndex, traj) {
  const min = state.min;
  const max = state.max;
  const verts = [
    [min.x - traj[0], 0, min.z - traj[1]],
    [min.x - traj[0], 0, max.z - traj[1]],
    [max.x - traj[0], 0, max.z - traj[1]],
    [max.x - traj[0], 0, min.z - traj[1]],
  ];
  const pos = plane.geometry.attributes.position.array;
  for (let i = 0; i < 4; i += 1) {
    pos[i * 3] = verts[i][0];
    pos[i * 3 + 1] = verts[i][1];
    pos[i * 3 + 2] = verts[i][2];
  }
  plane.geometry.attributes.position.needsUpdate = true;
}

function updateTrajectory(frameIndex, traj) {
  if (frameIndex < 2) {
    trajectoryLine.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(0), 3)
    );
    return;
  }
  const points = new Float32Array(frameIndex * 3);
  for (let i = 0; i < frameIndex; i += 1) {
    points[i * 3] = state.trajec[i][0] - traj[0];
    points[i * 3 + 1] = 0;
    points[i * 3 + 2] = state.trajec[i][1] - traj[1];
  }
  trajectoryLine.geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(points, 3)
  );
}

function setFrames(frames) {
  state.frames = preprocessFrames(frames);
  state.joints = frames[0]?.length ?? 0;
  state.maxFrames = state.frames.length;
  state.frame = 0;
  state.playing = state.maxFrames > 1;
  state.frameAccumulator = 0;
  state.lastTime = 0;
  playPause.textContent = state.playing ? "Pause" : "Play";
  frameScrub.max = Math.max(0, state.maxFrames - 1);
  frameScrub.value = "0";
  buildSkeletonMeshes();
  setCameraDefault();
  updateSkeleton(0);
  if (status) {
    status.textContent = `Loaded: ${state.source} (${state.maxFrames} frames)`;
  }
}

function animate(time) {
  resize();
  if (!state.lastTime) state.lastTime = time;
  const delta = time - state.lastTime;
  state.lastTime = time;
  if (state.playing && state.maxFrames > 0) {
    const frameDuration = 1000 / state.fps;
    state.frameAccumulator += delta;
    const rawFrame = Math.floor(state.frameAccumulator / frameDuration);
    const nextFrame = state.recording
      ? Math.min(state.maxFrames - 1, rawFrame)
      : rawFrame % state.maxFrames;
    if (nextFrame !== state.frame) {
      state.frame = nextFrame;
      frameScrub.value = String(state.frame);
      updateSkeleton(state.frame);
      if (state.recording && state.frame >= state.maxFrames - 1) {
        stopRecording();
      }
    }
  }
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function qinv(q) {
  return [q[0], -q[1], -q[2], -q[3]];
}

function qrot(q, v) {
  const qvec = [q[1], q[2], q[3]];
  const uv = cross(qvec, v);
  const uuv = cross(qvec, uv);
  const s = q[0];
  return [
    v[0] + 2 * (s * uv[0] + uuv[0]),
    v[1] + 2 * (s * uv[1] + uuv[1]),
    v[2] + 2 * (s * uv[2] + uuv[2]),
  ];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function recoverRootRotPos(data) {
  const frames = data.length;
  const rotVel = data.map((row) => row[0]);
  const rRotAng = new Array(frames).fill(0);
  for (let i = 1; i < frames; i += 1) {
    rRotAng[i] = rRotAng[i - 1] + rotVel[i - 1];
  }

  const rRotQuat = rRotAng.map((ang) => [Math.cos(ang), 0, Math.sin(ang), 0]);
  const rPos = new Array(frames).fill(0).map(() => [0, 0, 0]);
  for (let i = 1; i < frames; i += 1) {
    rPos[i][0] = data[i - 1][1];
    rPos[i][2] = data[i - 1][2];
  }

  for (let i = 0; i < frames; i += 1) {
    rPos[i] = qrot(qinv(rRotQuat[i]), rPos[i]);
  }

  for (let i = 1; i < frames; i += 1) {
    rPos[i][0] += rPos[i - 1][0];
    rPos[i][2] += rPos[i - 1][2];
  }

  for (let i = 0; i < frames; i += 1) {
    rPos[i][1] = data[i][3];
  }
  return { rRotQuat, rPos };
}

function recoverFromRic(data, jointsNum) {
  const { rRotQuat, rPos } = recoverRootRotPos(data);
  const frames = data.length;
  const joints = [];

  for (let i = 0; i < frames; i += 1) {
    const row = data[i];
    const positions = [];
    const start = 4;
    const end = (jointsNum - 1) * 3 + 4;
    for (let j = start; j < end; j += 3) {
      positions.push([row[j], row[j + 1], row[j + 2]]);
    }

    const rootQuatInv = qinv(rRotQuat[i]);
    const rotated = positions.map((pos) => qrot(rootQuatInv, pos));
    for (const pos of rotated) {
      pos[0] += rPos[i][0];
      pos[2] += rPos[i][2];
    }

    joints.push([rPos[i], ...rotated]);
  }

  return joints;
}

function parseJointsJson(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload.frames) return payload.frames;
  if (payload.joints) return payload.joints;
  return null;
}

function parseRicJson(payload) {
  const data = payload.data || payload.ric || payload.frames;
  const jointsNum = payload.joints_num || payload.jointsNum || payload.joints || 22;
  if (!data) return null;
  return recoverFromRic(data, jointsNum);
}

function parseNpy(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 10) {
    return { ok: false, reason: "buffer too small" };
  }
  const magicOk =
    bytes[0] === 0x93 &&
    bytes[1] === 0x4e &&
    bytes[2] === 0x55 &&
    bytes[3] === 0x4d &&
    bytes[4] === 0x50 &&
    bytes[5] === 0x59;
  if (!magicOk) {
    return { ok: false, reason: "bad magic header" };
  }
  const view = new DataView(buffer);
  const major = view.getUint8(6);
  const minor = view.getUint8(7);
  let headerLen = 0;
  let offset = 8;
  if (major === 1) {
    headerLen = view.getUint16(offset, true);
    offset += 2;
  } else if (major === 2) {
    headerLen = view.getUint32(offset, true);
    offset += 4;
  } else {
    return { ok: false, reason: `unsupported npy version ${major}.${minor}` };
  }

  if (offset + headerLen > bytes.length) {
    return { ok: false, reason: "header length out of bounds" };
  }
  const headerBytes = new Uint8Array(buffer, offset, headerLen);
  const headerText = new TextDecoder("latin1").decode(headerBytes);
  offset += headerLen;

  const descrRegex = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/;
  const shapeRegex = /['"]shape['"]\s*:\s*\(([^)]*)\)/;
  const descrMatch = headerText.match(descrRegex);
  const shapeMatch = headerText.match(shapeRegex);
  if (!descrMatch || !shapeMatch) {
    return {
      ok: false,
      reason: "missing descr/shape",
      headerText,
      descrMatch,
      shapeMatch,
      descrRegex: String(descrRegex),
      shapeRegex: String(shapeRegex),
    };
  }
  const descr = descrMatch[1];
  const shape = shapeMatch[1]
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => Number.parseInt(v, 10));
  if (shape.length < 2) {
    return { ok: false, reason: "shape too small", descr, shape, headerText };
  }
  if (descr !== "<f4") {
    return { ok: false, reason: `unsupported descr ${descr}`, shape, headerText };
  }

  const total = shape.reduce((a, b) => a * b, 1);
  if (offset + total * 4 > bytes.length) {
    return { ok: false, reason: "data length out of bounds", shape, descr };
  }
  const data = new Array(total);
  for (let i = 0; i < total; i += 1) {
    data[i] = view.getFloat32(offset + i * 4, true);
  }

  const rows = shape[0];
  const cols = shape[1];
  const frames = new Array(rows);
  for (let r = 0; r < rows; r += 1) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c += 1) {
      row[c] = data[r * cols + c];
    }
    frames[r] = row;
  }
  return { ok: true, frames, shape, descr, headerText };
}

function ricFromNpy(frames) {
  const dims = frames[0]?.length ?? 0;
  if (dims >= 67) {
    return recoverFromRic(
      frames.map((row) => row.slice(0, 67)),
      22
    );
  }
  return null;
}

function loadJsonFile(file, handler) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      handler(payload);
    } catch (err) {
      alert("Failed to parse JSON file.");
    }
  };
  reader.readAsText(file);
}

function loadNpyFile(file, handler) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const buffer = reader.result;
      const parsed = parseNpy(buffer);
      if (!parsed || !parsed.ok) {
        console.error("NPY parse details", parsed);
        throw new Error("parse failed");
      }
      handler(parsed);
    } catch (err) {
      console.error("NPY parse error", err);
      alert("Failed to parse NPY file. Check console for details.");
    }
  };
  reader.readAsArrayBuffer(file);
}

playPause.addEventListener("click", () => {
  state.playing = !state.playing;
  playPause.textContent = state.playing ? "Pause" : "Play";
});

fpsInput.addEventListener("change", (event) => {
  const value = Number(event.target.value);
  if (!Number.isNaN(value) && value > 0) {
    state.fps = value;
  }
});

frameScrub.addEventListener("input", (event) => {
  state.frame = Number(event.target.value);
  state.playing = false;
  state.recording = false;
  playPause.textContent = "Play";
  updateSkeleton(state.frame);
});

jointsFile.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  loadJsonFile(file, (payload) => {
    const frames = parseJointsJson(payload);
    if (!frames) {
      alert("Invalid joints JSON format.");
      return;
    }
    state.source = file.name;
    setFrames(frames);
  });
});

ricFile.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  loadJsonFile(file, (payload) => {
    const frames = parseRicJson(payload);
    if (!frames) {
      alert("Invalid RIC JSON format.");
      return;
    }
    state.source = file.name;
    setFrames(frames);
  });
});

npyFile.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  loadNpyFile(file, (parsed) => {
    const joints = ricFromNpy(parsed.frames);
    if (!joints) {
      alert("NPY format not recognized for RIC conversion.");
      return;
    }
    state.source = file.name;
    setFrames(joints);
  });
});

let recorder = null;
let recordChunks = [];

function startRecording() {
  if (state.maxFrames <= 1) return;
  if (!canvas.captureStream || !window.MediaRecorder) {
    alert("Recording is not supported in this browser.");
    return;
  }
  recordChunks = [];
  const resumeAfter = state.playing;
  const stream = canvas.captureStream(state.fps);
  recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordChunks.push(event.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(recordChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${state.source.replace(/\\W+/g, "_") || "motion"}.webm`;
    link.click();
    URL.revokeObjectURL(url);
    state.playing = resumeAfter;
    if (state.playing) {
      state.frameAccumulator = state.frame * (1000 / state.fps);
      state.lastTime = 0;
    }
  };
  recorder.start();
  state.recording = true;
  state.playing = true;
  state.frame = 0;
  state.frameAccumulator = 0;
  state.lastTime = 0;
  updateSkeleton(0);
  recordBtn.textContent = "Recording...";
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  state.recording = false;
  state.playing = false;
  recordBtn.textContent = "Record WebM";
}

recordBtn.addEventListener("click", () => {
  if (state.recording) {
    stopRecording();
  } else {
    startRecording();
  }
});

function generateIdleFrame() {
  // T2M 22-joint ordering to match kinematic chains.
  return [
    [0.0, 1.0, 0.0],   // 0 root
    [-0.15, 0.95, 0.0], // 1 left hip
    [0.15, 0.95, 0.0],  // 2 right hip
    [0.0, 1.25, 0.0],  // 3 spine1
    [-0.18, 0.6, 0.02], // 4 left knee
    [0.18, 0.6, 0.02],  // 5 right knee
    [0.0, 1.45, 0.0],  // 6 spine2
    [-0.18, 0.25, 0.05], // 7 left ankle
    [0.18, 0.25, 0.05],  // 8 right ankle
    [0.0, 1.6, 0.0],   // 9 spine3 / chest
    [-0.18, 0.05, 0.12], // 10 left foot
    [0.18, 0.05, 0.12],  // 11 right foot
    [0.0, 1.78, 0.0],  // 12 neck
    [-0.25, 1.58, 0.0], // 13 left collar
    [0.25, 1.58, 0.0],  // 14 right collar
    [0.0, 1.98, 0.02], // 15 head
    [-0.45, 1.45, 0.0], // 16 left shoulder
    [0.45, 1.45, 0.0],  // 17 right shoulder
    [-0.62, 1.2, 0.05], // 18 left elbow
    [0.62, 1.2, 0.05],  // 19 right elbow
    [-0.75, 0.95, 0.08], // 20 left wrist
    [0.75, 0.95, 0.08],  // 21 right wrist
  ];
}

setFrames([generateIdleFrame()]);

async function loadExampleNpy() {
  try {
    const response = await fetch("./000000.npy");
    if (!response.ok) return;
    const buffer = await response.arrayBuffer();
    const parsed = parseNpy(buffer);
    if (!parsed) return;
    const joints = ricFromNpy(parsed.frames);
    if (joints) {
      state.source = "000000.npy";
      setFrames(joints);
    }
  } catch (err) {
    // Keep idle pose if example load fails.
  }
}

loadExampleNpy();
setCameraDefault();
requestAnimationFrame(animate);
