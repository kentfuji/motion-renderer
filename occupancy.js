import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { unzipSync } from "fflate";

const t2mBaseChain = [
	[0, 2, 5, 8, 11],
	[0, 1, 4, 7, 10],
	[0, 3, 6, 9, 12, 15],
	[9, 14, 17, 19, 21],
	[9, 13, 16, 18, 20],
];

const colors = [
	"#2f6bdb",
	"#4fb0c6",
	"#d64a3a",
	"#58b15e",
	"#f0a53a",
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
	recording: false,
	frame: 0,
	frameAccumulator: 0,
	lastTime: 0,
	frames: [],
	joints: 0,
	maxFrames: 0,
	motionSource: "none",
	occupancySource: "none",
	rootPositions: [],
	trajectory: [],
	followRoot: true,
	showTrajectory: true,
	showMesh: true,
	voxelUnit: 0.08,
	voxelPositions: [],
	npzRootPositions: [],
	npzVertices: [],
	npzFaces: [],
	min: new THREE.Vector3(),
	max: new THREE.Vector3(),
	crop: {
		active: false,
		rect: null,
		preview: true,
	},
};

const canvas = document.getElementById("canvas");
const playPause = document.getElementById("playPause");
const npzFile = document.getElementById("npzFile");
const jointsFile = document.getElementById("jointsFile");
const ricFile = document.getElementById("ricFile");
const npyFile = document.getElementById("npyFile");
const recordBtn = document.getElementById("recordBtn");
const cropBtn = document.getElementById("cropBtn");
const clearCropBtn = document.getElementById("clearCropBtn");
const applyCropBtn = document.getElementById("applyCropBtn");
const cropX = document.getElementById("cropX");
const cropY = document.getElementById("cropY");
const cropW = document.getElementById("cropW");
const cropH = document.getElementById("cropH");
const cropPreview = document.getElementById("cropPreview");
const followRoot = document.getElementById("followRoot");
const showTrajectory = document.getElementById("showTrajectory");
const showMesh = document.getElementById("showMesh");
const fpsInput = document.getElementById("fpsInput");
const frameScrub = document.getElementById("frameScrub");
const status = document.getElementById("status");
const stats = document.getElementById("stats");
const cropOverlay = document.getElementById("cropOverlay");
const cropBox = document.getElementById("cropBox");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const cropCanvas = document.createElement("canvas");
const cropCtx = cropCanvas.getContext("2d");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const ambient = new THREE.AmbientLight(0xffffff, 0.6);
const dir = new THREE.DirectionalLight(0xffffff, 0.6);
dir.position.set(3, 5, 4);
scene.add(ambient, dir);

const occupancyGroup = new THREE.Group();
scene.add(occupancyGroup);
const skeletonGroup = new THREE.Group();
scene.add(skeletonGroup);
const meshGroup = new THREE.Group();
scene.add(meshGroup);

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
	opacity: 0.25,
	side: THREE.DoubleSide,
});
const plane = new THREE.Mesh(planeGeometry, planeMaterial);
scene.add(plane);

let jointMeshes = [];
let boneMeshes = [];
let bonePairs = [];
let voxelMesh = null;
let smplMesh = null;

function hasMotionFrames() {
	return state.frames.length > 0 && state.joints > 0;
}

function resize() {
	const { clientWidth, clientHeight } = canvas;
	if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
		renderer.setSize(clientWidth, clientHeight, false);
		camera.aspect = clientWidth / clientHeight;
		camera.updateProjectionMatrix();
	}
}

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
	controls.saveState();
}

function disposeMesh(mesh) {
	if (!mesh) return;
	mesh.geometry.dispose();
	if (Array.isArray(mesh.material)) {
		mesh.material.forEach((material) => material.dispose());
	} else {
		mesh.material.dispose();
	}
}

function buildSkeletonMeshes() {
	jointMeshes.forEach((mesh) => {
		disposeMesh(mesh);
		skeletonGroup.remove(mesh);
	});
	boneMeshes.forEach((mesh) => {
		disposeMesh(mesh);
		skeletonGroup.remove(mesh);
	});
	jointMeshes = [];
	boneMeshes = [];
	bonePairs = [];

	if (!hasMotionFrames()) {
		skeletonGroup.visible = false;
		return;
	}
	skeletonGroup.visible = true;

	const jointColorMap = new Array(state.joints).fill("#d7dee8");
	const chainCount = Math.min(t2mBaseChain.length, colors.length);
	for (let i = 0; i < chainCount; i += 1) {
		const chain = t2mBaseChain[i];
		for (const jointIdx of chain) {
			if (jointIdx < jointColorMap.length) {
				jointColorMap[jointIdx] = colors[i];
			}
		}
	}
	const spineColor = colors[2];
	for (const jointIdx of [0, 3, 6, 9, 12, 15]) {
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
		const chain = t2mBaseChain[i];
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

function buildVoxelMesh() {
	if (voxelMesh) {
		disposeMesh(voxelMesh);
		occupancyGroup.remove(voxelMesh);
		voxelMesh = null;
	}
	const count = state.voxelPositions.length;
	if (count === 0) return;

	const geometry = new THREE.BoxGeometry(
		state.voxelUnit * 0.94,
		state.voxelUnit * 0.94,
		state.voxelUnit * 0.94
	);
	const material = new THREE.MeshStandardMaterial({
		color: "#4fb0c6",
		transparent: true,
		opacity: 0.14,
		roughness: 0.5,
		metalness: 0.02,
		depthWrite: false,
	});
	voxelMesh = new THREE.InstancedMesh(geometry, material, count);
	voxelMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
	const matrix = new THREE.Matrix4();
	for (let i = 0; i < count; i += 1) {
		const pos = state.voxelPositions[i];
		matrix.makeTranslation(pos[0], pos[1], pos[2]);
		voxelMesh.setMatrixAt(i, matrix);
	}
	voxelMesh.instanceMatrix.needsUpdate = true;
	occupancyGroup.add(voxelMesh);
}

function buildSmplMesh() {
	if (smplMesh) {
		disposeMesh(smplMesh);
		meshGroup.remove(smplMesh);
		smplMesh = null;
	}
	const frames = state.npzVertices;
	if (!frames.length || !frames[0]?.length) return;

	const firstFrame = frames[0];
	const positions = new Float32Array(firstFrame.length * 3);
	for (let i = 0; i < firstFrame.length; i += 1) {
		positions[i * 3] = firstFrame[i][0];
		positions[i * 3 + 1] = firstFrame[i][1];
		positions[i * 3 + 2] = firstFrame[i][2];
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	if (state.npzFaces.length) {
		const indices = new Uint32Array(state.npzFaces.length * 3);
		for (let i = 0; i < state.npzFaces.length; i += 1) {
			indices[i * 3] = state.npzFaces[i][0];
			indices[i * 3 + 1] = state.npzFaces[i][1];
			indices[i * 3 + 2] = state.npzFaces[i][2];
		}
		geometry.setIndex(new THREE.BufferAttribute(indices, 1));
		geometry.computeVertexNormals();
		smplMesh = new THREE.Mesh(
			geometry,
			new THREE.MeshStandardMaterial({
				color: "#d64a3a",
				transparent: true,
				opacity: 0.38,
				roughness: 0.6,
				metalness: 0.02,
				side: THREE.DoubleSide,
			})
		);
	} else {
		smplMesh = new THREE.Points(
			geometry,
			new THREE.PointsMaterial({
				color: "#d64a3a",
				size: 0.012,
				sizeAttenuation: true,
				transparent: true,
				opacity: 0.6,
			})
		);
	}
	meshGroup.add(smplMesh);
}

function computeStats() {
	const min = new THREE.Vector3(Infinity, Infinity, Infinity);
	const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
	for (const frame of state.frames) {
		for (const joint of frame) {
			min.min(new THREE.Vector3(joint[0], joint[1], joint[2]));
			max.max(new THREE.Vector3(joint[0], joint[1], joint[2]));
		}
	}
	for (const pos of state.voxelPositions) {
		min.min(new THREE.Vector3(pos[0], pos[1], pos[2]));
		max.max(new THREE.Vector3(pos[0], pos[1], pos[2]));
	}
	for (const frame of state.npzVertices) {
		for (const vertex of frame) {
			min.min(new THREE.Vector3(vertex[0], vertex[1], vertex[2]));
			max.max(new THREE.Vector3(vertex[0], vertex[1], vertex[2]));
		}
	}
	if (!Number.isFinite(min.x)) {
		min.set(-1, 0, -1);
		max.set(1, 2, 1);
	}
	state.min.copy(min);
	state.max.copy(max);
}

function computeBounds(points) {
	const min = new THREE.Vector3(Infinity, Infinity, Infinity);
	const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
	for (const point of points) {
		min.min(new THREE.Vector3(point[0], point[1], point[2]));
		max.max(new THREE.Vector3(point[0], point[1], point[2]));
	}
	if (!Number.isFinite(min.x)) {
		return null;
	}
	return { min, max, size: max.clone().sub(min) };
}

function flattenMotionFrames(frames) {
	const points = [];
	for (const frame of frames) {
		for (const joint of frame) {
			points.push(joint);
		}
	}
	return points;
}

function computeTrajectoryError(a, b) {
	if (!a.length || !b.length) return null;
	const count = Math.min(a.length, b.length);
	let sum = 0;
	let max = 0;
	for (let i = 0; i < count; i += 1) {
		const dx = a[i][0] - b[i][0];
		const dy = a[i][1] - b[i][1];
		const dz = a[i][2] - b[i][2];
		const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
		sum += dist;
		max = Math.max(max, dist);
	}
	return { mean: sum / count, max, frames: count };
}

function getAvailableFrameCount() {
	return Math.max(state.frames.length, state.npzVertices.length, state.npzRootPositions.length, 1);
}

function getActiveRootPositions() {
	if (state.rootPositions.length === getAvailableFrameCount()) {
		return state.rootPositions;
	}
	if (state.npzRootPositions.length === getAvailableFrameCount()) {
		return state.npzRootPositions;
	}
	return state.rootPositions.length ? state.rootPositions : state.npzRootPositions;
}

function getFrameAt(frames, frameIndex) {
	if (!frames.length) return null;
	return frames[Math.min(frameIndex, frames.length - 1)] || null;
}

function updatePlane(offsetX, offsetZ) {
	const min = state.min;
	const max = state.max;
	const verts = [
		[min.x - offsetX, 0, min.z - offsetZ],
		[min.x - offsetX, 0, max.z - offsetZ],
		[max.x - offsetX, 0, max.z - offsetZ],
		[max.x - offsetX, 0, min.z - offsetZ],
	];
	const pos = plane.geometry.attributes.position.array;
	for (let i = 0; i < 4; i += 1) {
		pos[i * 3] = verts[i][0];
		pos[i * 3 + 1] = verts[i][1];
		pos[i * 3 + 2] = verts[i][2];
	}
	plane.geometry.attributes.position.needsUpdate = true;
}

function updateTrajectory(frameIndex, offsetX, offsetZ) {
	trajectoryLine.visible = state.showTrajectory;
	const trajectoryCount = Math.min(frameIndex + 1, state.trajectory.length);
	if (!state.showTrajectory || trajectoryCount < 2) {
		trajectoryLine.geometry.setAttribute(
			"position",
			new THREE.BufferAttribute(new Float32Array(0), 3)
		);
		return;
	}
	const points = new Float32Array(trajectoryCount * 3);
	for (let i = 0; i < trajectoryCount; i += 1) {
		points[i * 3] = state.trajectory[i][0] - offsetX;
		points[i * 3 + 1] = 0;
		points[i * 3 + 2] = state.trajectory[i][1] - offsetZ;
	}
	trajectoryLine.geometry.setAttribute(
		"position",
		new THREE.BufferAttribute(points, 3)
	);
}

function updateFrame(frameIndex) {
	const hasMotion = hasMotionFrames();
	skeletonGroup.visible = hasMotion;
	const frame = hasMotion ? getFrameAt(state.frames, frameIndex) : null;
	const activeRoots = getActiveRootPositions();
	const root = getFrameAt(activeRoots, frameIndex) || [0, 0, 0];
	const offsetX = state.followRoot ? root[0] : 0;
	const offsetZ = state.followRoot ? root[2] : 0;

	for (let i = 0; i < jointMeshes.length; i += 1) {
		jointMeshes[i].visible = Boolean(frame);
		if (!frame) continue;
		const joint = frame[i] || [0, 0, 0];
		jointMeshes[i].position.set(joint[0] - offsetX, joint[1], joint[2] - offsetZ);
	}

	const up = new THREE.Vector3(0, 1, 0);
	for (let i = 0; i < boneMeshes.length; i += 1) {
		boneMeshes[i].visible = Boolean(frame);
		if (!frame) continue;
		const [aIdx, bIdx] = bonePairs[i];
		const a = frame[aIdx] || [0, 0, 0];
		const b = frame[bIdx] || [0, 0, 0];
		const start = new THREE.Vector3(a[0] - offsetX, a[1], a[2] - offsetZ);
		const end = new THREE.Vector3(b[0] - offsetX, b[1], b[2] - offsetZ);
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

	occupancyGroup.position.set(-offsetX, 0, -offsetZ);
	const meshRoot = getFrameAt(state.npzRootPositions, frameIndex);
	const meshOffset = meshRoot
		? [root[0] - meshRoot[0], root[1] - meshRoot[1], root[2] - meshRoot[2]]
		: [0, 0, 0];
	meshGroup.position.set(meshOffset[0] - offsetX, meshOffset[1], meshOffset[2] - offsetZ);
	if (smplMesh) {
		const vertices = getFrameAt(state.npzVertices, frameIndex);
		smplMesh.visible = state.showMesh && Boolean(vertices);
		if (vertices) {
			const positions = smplMesh.geometry.attributes.position.array;
			for (let i = 0; i < vertices.length; i += 1) {
				positions[i * 3] = vertices[i][0];
				positions[i * 3 + 1] = vertices[i][1];
				positions[i * 3 + 2] = vertices[i][2];
			}
			smplMesh.geometry.attributes.position.needsUpdate = true;
			if (smplMesh.isMesh) {
				smplMesh.geometry.computeVertexNormals();
			}
		}
	}
	updatePlane(offsetX, offsetZ);
	updateTrajectory(frameIndex, offsetX, offsetZ);
}

function updateStatus() {
	status.textContent = `Motion: ${state.motionSource} · Occupancy: ${state.occupancySource}`;
	const motionBounds = computeBounds(flattenMotionFrames(state.frames));
	const occupancyBounds = computeBounds(state.voxelPositions);
	const meshBounds = computeBounds(state.npzVertices.flat());
	const motionText = motionBounds
		? `Motion bbox: ${motionBounds.size.x.toFixed(2)} x ${motionBounds.size.y.toFixed(2)} x ${motionBounds.size.z.toFixed(2)}`
		: "Motion bbox: none";
	const occupancyText = occupancyBounds
		? `Occupancy bbox: ${occupancyBounds.size.x.toFixed(2)} x ${occupancyBounds.size.y.toFixed(2)} x ${occupancyBounds.size.z.toFixed(2)}`
		: "Occupancy bbox: none";
	const meshText = meshBounds
		? `SMPL bbox: ${meshBounds.size.x.toFixed(2)} x ${meshBounds.size.y.toFixed(2)} x ${meshBounds.size.z.toFixed(2)}`
		: "SMPL bbox: none";
	const trajError = computeTrajectoryError(state.rootPositions, state.npzRootPositions);
	const trajText = trajError
		? `Root match mean/max: ${trajError.mean.toExponential(2)} / ${trajError.max.toExponential(2)}`
		: "Root match: unavailable";
	stats.textContent = `Frames: ${state.maxFrames} · Free or swept voxels: ${state.voxelPositions.length.toLocaleString()} · Voxel unit: ${state.voxelUnit} · ${motionText} · ${occupancyText} · ${meshText} · ${trajText}`;
}

function applyState() {
	if (!state.frames.length) {
		state.joints = 0;
	}
	state.maxFrames = getAvailableFrameCount();
	state.frame = 0;
	state.playing = state.maxFrames > 1;
	state.frameAccumulator = 0;
	state.lastTime = 0;
	playPause.textContent = state.playing ? "Pause" : "Play";
	frameScrub.max = Math.max(0, state.maxFrames - 1);
	frameScrub.value = "0";
	computeStats();
	buildSkeletonMeshes();
	buildVoxelMesh();
	buildSmplMesh();
	updateFrame(0);
	updateStatus();
}

function setMotionFrames(frames, sourceName) {
	state.frames = frames;
	state.rootPositions = frames.map((frame) => frame[0]);
	state.trajectory = state.rootPositions.map((root) => [root[0], root[2]]);
	state.motionSource = sourceName;
	state.joints = frames[0]?.length ?? 0;
	applyState();
}

function setOccupancyData(
	voxelPositions,
	unit,
	sourceName,
	npzRootPositions = [],
	npzVertices = [],
	npzFaces = []
) {
	state.voxelPositions = voxelPositions;
	state.voxelUnit = unit;
	state.npzRootPositions = npzRootPositions;
	state.npzVertices = npzVertices;
	state.npzFaces = npzFaces;
	state.occupancySource = sourceName;
	applyState();
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
			updateFrame(state.frame);
			if (state.recording && state.frame >= state.maxFrames - 1) {
				stopRecording();
			}
		}
	}
	controls.update();
	renderer.render(scene, camera);
	if (state.recording && state.crop.active && state.crop.rect) {
		drawCropFrame();
	}
	requestAnimationFrame(animate);
}

function qinv(q) {
	return [q[0], -q[1], -q[2], -q[3]];
}

function cross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
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

function parseNpy(bytes) {
	if (bytes.length < 10) throw new Error("buffer too small");
	const magicOk =
		bytes[0] === 0x93 &&
		bytes[1] === 0x4e &&
		bytes[2] === 0x55 &&
		bytes[3] === 0x4d &&
		bytes[4] === 0x50 &&
		bytes[5] === 0x59;
	if (!magicOk) throw new Error("bad npy magic header");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
		throw new Error(`unsupported npy version ${major}.${minor}`);
	}
	const headerText = new TextDecoder("latin1").decode(new Uint8Array(bytes.buffer, bytes.byteOffset + offset, headerLen));
	offset += headerLen;
	const descrMatch = headerText.match(/['"]descr['"]\s*:\s*['"]([^'"]+)['"]/);
	const shapeMatch = headerText.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/);
	const fortranMatch = headerText.match(/['"]fortran_order['"]\s*:\s*(True|False)/);
	if (!descrMatch || !shapeMatch) throw new Error("missing descr or shape in npy header");
	const descr = descrMatch[1];
	const fortranOrder = fortranMatch ? fortranMatch[1] === "True" : false;
	const shape = shapeMatch[1]
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0)
		.map((v) => Number.parseInt(v, 10));
	const total = shape.reduce((a, b) => a * b, 1);
	if (descr !== "<f4" && descr !== "|u1" && descr !== "<i4") {
		throw new Error(`unsupported dtype ${descr}`);
	}
	let data;
	if (descr === "<f4") {
		data = new Float32Array(total);
		for (let i = 0; i < total; i += 1) {
			data[i] = view.getFloat32(offset + i * 4, true);
		}
	} else if (descr === "|u1") {
		data = new Uint8Array(bytes.buffer, bytes.byteOffset + offset, total);
	} else {
		data = new Int32Array(total);
		for (let i = 0; i < total; i += 1) {
			data[i] = view.getInt32(offset + i * 4, true);
		}
	}

	const rows = shape[0] || 1;
	const cols = shape[1] || 1;
	const frames = new Array(rows);
	for (let r = 0; r < rows; r += 1) {
		const row = new Array(cols);
		for (let c = 0; c < cols; c += 1) {
			const idx = fortranOrder ? c * rows + r : r * cols + c;
			row[c] = data[idx];
		}
		frames[r] = row;
	}
	return { descr, shape, frames, data };
}

function ricFromNpy(frames) {
	const dims = frames[0]?.length ?? 0;
	if (dims >= 67) {
		return recoverFromRic(frames.map((row) => row.slice(0, 67)), 22);
	}
	return null;
}

function parseProcessOccNpz(buffer) {
	const files = unzipSync(new Uint8Array(buffer));
	const arrays = {};
	for (const [name, bytes] of Object.entries(files)) {
		if (!name.endsWith(".npy")) continue;
		arrays[name.replace(/\.npy$/, "")] = parseNpy(bytes);
	}
	if (!arrays.global_occ || !arrays.llb || !arrays.unit) {
		throw new Error("NPZ is missing one of: global_occ, llb, unit");
	}
	return arrays;
}

function vectorValue(arrayInfo) {
	return Array.from(arrayInfo.data);
}

function scalarValue(arrayInfo) {
	return Number(arrayInfo.data[0]);
}

function zUpToYUp(point) {
	return [point[0], point[2], point[1]];
}

function extractFreeVoxelPositions(globalOcc, llb, unit) {
	const [sx, sy, sz] = globalOcc.shape;
	const positions = [];
	const data = globalOcc.data;
	for (let x = 0; x < sx; x += 1) {
		for (let y = 0; y < sy; y += 1) {
			for (let z = 0; z < sz; z += 1) {
				const idx = x * sy * sz + y * sz + z;
				if (data[idx] !== 0) continue;
				positions.push(zUpToYUp([
					llb[0] + (x + 0.5) * unit,
					llb[1] + (y + 0.5) * unit,
					llb[2] + (z + 0.5) * unit,
				]));
			}
		}
	}
	return positions;
}

function loadJsonFile(file, handler) {
	const reader = new FileReader();
	reader.onload = () => {
		try {
			const payload = JSON.parse(reader.result);
			handler(payload);
		} catch (error) {
			console.error(error);
			alert("Failed to parse JSON file.");
		}
	};
	reader.readAsText(file);
}

function loadOccupancyFile(file) {
	const reader = new FileReader();
	reader.onload = () => {
		try {
			const arrays = parseProcessOccNpz(reader.result);
			const llb = vectorValue(arrays.llb);
			const unit = scalarValue(arrays.unit);
			const voxelPositions = extractFreeVoxelPositions(arrays.global_occ, llb, unit);
			const npzRootPositions = arrays.root_pos
				? vectorRows(arrays.root_pos).map(zUpToYUp)
				: [];
			const npzVertices = arrays.vertices
				? vectorFrames(arrays.vertices).map((frame) => frame.map(zUpToYUp))
				: [];
			const npzFaces = arrays.faces ? vectorIndices(arrays.faces) : [];
			setOccupancyData(voxelPositions, unit, file.name, npzRootPositions, npzVertices, npzFaces);
		} catch (error) {
			console.error(error);
			alert(`Failed to parse occupancy NPZ: ${error.message}`);
		}
	};
	reader.readAsArrayBuffer(file);
}

function loadMotionNpyFile(file) {
	const reader = new FileReader();
	reader.onload = () => {
		try {
			const parsed = parseNpy(new Uint8Array(reader.result));
			const joints = ricFromNpy(parsed.frames);
			if (!joints) {
				alert("NPY format not recognized for RIC conversion.");
				return;
			}
			setMotionFrames(joints, file.name);
		} catch (error) {
			console.error(error);
			alert(`Failed to parse motion NPY: ${error.message}`);
		}
	};
	reader.readAsArrayBuffer(file);
}

function vectorRows(arrayInfo) {
	const rows = arrayInfo.shape[0] || 0;
	const cols = arrayInfo.shape[1] || 0;
	const out = [];
	for (let r = 0; r < rows; r += 1) {
		const row = [];
		for (let c = 0; c < cols; c += 1) {
			row.push(arrayInfo.data[r * cols + c]);
		}
		out.push(row);
	}
	return out;
}

function vectorFrames(arrayInfo) {
	const frameCount = arrayInfo.shape[0] || 0;
	const pointCount = arrayInfo.shape[1] || 0;
	const dims = arrayInfo.shape[2] || 0;
	const out = [];
	for (let frameIdx = 0; frameIdx < frameCount; frameIdx += 1) {
		const frame = [];
		for (let pointIdx = 0; pointIdx < pointCount; pointIdx += 1) {
			const point = [];
			for (let dim = 0; dim < dims; dim += 1) {
				const idx = frameIdx * pointCount * dims + pointIdx * dims + dim;
				point.push(arrayInfo.data[idx]);
			}
			frame.push(point);
		}
		out.push(frame);
	}
	return out;
}

function vectorIndices(arrayInfo) {
	return vectorRows(arrayInfo);
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

followRoot.addEventListener("change", (event) => {
	state.followRoot = event.target.checked;
	updateFrame(state.frame);
});

showTrajectory.addEventListener("change", (event) => {
	state.showTrajectory = event.target.checked;
	updateFrame(state.frame);
});

showMesh.addEventListener("change", (event) => {
	state.showMesh = event.target.checked;
	updateFrame(state.frame);
});

frameScrub.addEventListener("input", (event) => {
	state.frame = Number(event.target.value);
	state.playing = false;
	state.recording = false;
	playPause.textContent = "Play";
	updateFrame(state.frame);
});

npzFile.addEventListener("change", (event) => {
	const file = event.target.files[0];
	if (!file) return;
	loadOccupancyFile(file);
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
		setMotionFrames(frames, file.name);
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
		setMotionFrames(frames, file.name);
	});
});

npyFile.addEventListener("change", (event) => {
	const file = event.target.files[0];
	if (!file) return;
	loadMotionNpyFile(file);
});

let recorder = null;
let recordChunks = [];

function getCropSourceRect() {
	if (!state.crop.rect) return null;
	const rect = state.crop.rect;
	const canvasRect = canvas.getBoundingClientRect();
	const scaleX = canvas.width / canvasRect.width;
	const scaleY = canvas.height / canvasRect.height;
	const sx = Math.round(rect.x * scaleX);
	const sy = Math.round(rect.y * scaleY);
	const sw = Math.max(1, Math.round(rect.width * scaleX));
	const sh = Math.max(1, Math.round(rect.height * scaleY));
	return { sx, sy, sw, sh };
}

function drawCropFrame() {
	const src = getCropSourceRect();
	if (!src) return;
	if (cropCanvas.width !== src.sw || cropCanvas.height !== src.sh) {
		cropCanvas.width = src.sw;
		cropCanvas.height = src.sh;
	}
	cropCtx.drawImage(
		canvas,
		src.sx,
		src.sy,
		src.sw,
		src.sh,
		0,
		0,
		cropCanvas.width,
		cropCanvas.height
	);
}

function startRecording() {
	if (state.maxFrames <= 1) return;
	if (!canvas.captureStream || !window.MediaRecorder) {
		alert("Recording is not supported in this browser.");
		return;
	}
	recordChunks = [];
	const resumeAfter = state.playing;
	const stream = state.crop.active && state.crop.rect
		? cropCanvas.captureStream(state.fps)
		: canvas.captureStream(state.fps);
	recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
	recorder.ondataavailable = (event) => {
		if (event.data.size > 0) recordChunks.push(event.data);
	};
	recorder.onstop = () => {
		const blob = new Blob(recordChunks, { type: "video/webm" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${state.motionSource.replace(/\W+/g, "_") || "occupancy_motion"}.webm`;
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
	updateFrame(0);
	if (state.crop.active && state.crop.rect) {
		drawCropFrame();
	}
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

let cropDrag = null;

function updateCropBox(rect) {
	if (!cropBox || !rect || !state.crop.preview) return;
	cropBox.style.display = "block";
	cropBox.style.left = `${rect.x}px`;
	cropBox.style.top = `${rect.y}px`;
	cropBox.style.width = `${rect.width}px`;
	cropBox.style.height = `${rect.height}px`;
	if (cropX) cropX.value = Math.round(rect.x);
	if (cropY) cropY.value = Math.round(rect.y);
	if (cropW) cropW.value = Math.round(rect.width);
	if (cropH) cropH.value = Math.round(rect.height);
}

function clearCrop() {
	state.crop.active = false;
	state.crop.rect = null;
	if (cropBox) cropBox.style.display = "none";
	if (cropBtn) cropBtn.textContent = "Select Crop";
	if (cropOverlay) cropOverlay.style.pointerEvents = "none";
}

function enableCropSelection() {
	state.crop.active = true;
	if (cropBtn) cropBtn.textContent = "Drag Crop";
	if (cropOverlay) cropOverlay.style.pointerEvents = "auto";
}

cropBtn.addEventListener("click", () => {
	if (!state.crop.active) {
		enableCropSelection();
	} else {
		cropBtn.textContent = "Select Crop";
	}
});

clearCropBtn.addEventListener("click", () => {
	clearCrop();
});

cropOverlay.addEventListener("pointerdown", (event) => {
	if (!state.crop.active) return;
	const rect = canvas.getBoundingClientRect();
	const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
	const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
	cropDrag = { startX: x, startY: y };
	cropOverlay.setPointerCapture(event.pointerId);
});

cropOverlay.addEventListener("pointermove", (event) => {
	if (!state.crop.active || !cropDrag) return;
	const rect = canvas.getBoundingClientRect();
	const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
	const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
	const left = Math.min(cropDrag.startX, x);
	const top = Math.min(cropDrag.startY, y);
	const width = Math.max(4, Math.abs(x - cropDrag.startX));
	const height = Math.max(4, Math.abs(y - cropDrag.startY));
	const cropRect = { x: left, y: top, width, height };
	state.crop.rect = cropRect;
	updateCropBox(cropRect);
});

cropOverlay.addEventListener("pointerup", (event) => {
	if (!state.crop.active || !cropDrag) return;
	cropDrag = null;
	cropOverlay.releasePointerCapture(event.pointerId);
	if (cropBtn) cropBtn.textContent = "Select Crop";
	if (cropOverlay) cropOverlay.style.pointerEvents = "none";
});

cropOverlay.addEventListener("pointerleave", () => {
	if (!state.crop.active || !cropDrag) return;
	cropDrag = null;
});

applyCropBtn.addEventListener("click", () => {
	const rect = canvas.getBoundingClientRect();
	const x = Math.max(0, Math.min(rect.width, Number(cropX.value)));
	const y = Math.max(0, Math.min(rect.height, Number(cropY.value)));
	const width = Math.max(1, Math.min(rect.width - x, Number(cropW.value)));
	const height = Math.max(1, Math.min(rect.height - y, Number(cropH.value)));
	state.crop.active = true;
	state.crop.rect = { x, y, width, height };
	updateCropBox(state.crop.rect);
});

cropPreview.addEventListener("change", (event) => {
	state.crop.preview = event.target.checked;
	if (state.crop.preview && state.crop.rect) {
		updateCropBox(state.crop.rect);
	} else if (cropBox) {
		cropBox.style.display = "none";
	}
});

setOccupancyData([], 0.08, "none", [], []);
setCameraDefault();
requestAnimationFrame(animate);
