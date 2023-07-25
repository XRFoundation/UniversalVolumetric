import {
  BufferGeometry,
  CompressedArrayTexture,
  GLSL3,
  Material,
  Mesh,
  MeshBasicMaterial,
  ShaderChunk,
  ShaderMaterial,
  WebGLRenderer
} from 'three'

import { onFrameShowCallback, onMeshBufferingCallback, onTrackEndCallback, V2FileHeader } from '../Interfaces'
import { FORMATS_TO_EXT, GeometryTarget, KTX2TextureTarget } from '../Interfaces'
import { DRACOLoader } from '../lib/DRACOLoader'
import { KTX2Loader } from '../lib/KTX2Loader'

export interface fetchBuffersCallback {
  (): void
}

export type PlayerConstructorArgs = {
  renderer: WebGLRenderer
  onMeshBuffering?: onMeshBufferingCallback
  onFrameShow?: onFrameShowCallback
  mesh: Mesh
  onTrackEnd: onTrackEndCallback
  audio?: HTMLAudioElement | HTMLVideoElement // both <audio> and <video> elements can play audio,
}

// currentTime in seconds
function getCurrentFrame(targetData: GeometryTarget | KTX2TextureTarget, currentTime: number) {
  return Math.round(targetData.frameRate * currentTime)
}

/**
 * Utility function to pad 'n' with 'width' number of '0' characters.
 * This is used when expanding URLs, which are filled with '#'
 * For example: frame_#### is expanded to frame_0000, frame_0010, frame_0100 etc...
 */
function pad(n: number, width: number) {
  const padChar = '0'
  let paddedN = n.toString()
  return paddedN.length >= width ? paddedN : new Array(width - paddedN.length + 1).join(padChar) + paddedN
}

function countHashChar(URL: string) {
  let count = 0
  for (let i = 0; i < URL.length; i++) {
    if (URL[i] === '#') {
      count++
    }
  }
  return count
}

export default class Player {
  // Public Fields
  public renderer: WebGLRenderer
  public bufferDuration = 4 // in seconds. Player tries to store frames sufficient to play these many seconds
  public intervalDuration = 2 // number of seconds between fetchBuffers calls

  // Three objects
  public mesh: Mesh
  private ktx2Loader: KTX2Loader
  private dracoLoader: DRACOLoader
  private failMaterial: Material | null = null
  private shaderMaterial: ShaderMaterial // to reuse this material
  private startTime: number // in milliseconds
  private pausedTime: number
  private totalPausedDuration: number
  private isClockPaused: boolean

  // Private Fields
  private currentTime: number = 0
  private meshMap: Map<number, BufferGeometry> = new Map()
  private textureMap: Map<number, CompressedArrayTexture> = new Map()
  private onMeshBuffering: onMeshBufferingCallback | null = null
  private onFrameShow: onFrameShowCallback | null = null
  private onTrackEnd: onTrackEndCallback | null = null
  private lastRequestedGeometryFrame: number
  private lastRequestedTextureSegment: number
  private audio: HTMLAudioElement
  private header: V2FileHeader | null
  private vertexShader: string
  private fragmentShader: string
  private intervalId: number
  private geometryTarget: string
  private textureTarget: string
  private textureType = 'baseColor'
  private textureTag = 'default'

  constructor({ renderer, onMeshBuffering, onFrameShow, mesh, onTrackEnd, audio }: PlayerConstructorArgs) {
    this.renderer = renderer

    this.onMeshBuffering = onMeshBuffering
    this.onFrameShow = onFrameShow

    /* This property is used by the parent components and rendered on the scene */
    this.mesh = mesh

    this.onTrackEnd = onTrackEnd

    this.ktx2Loader = new KTX2Loader()
    this.ktx2Loader.setTranscoderPath('https://unpkg.com/three@0.153.0/examples/jsm/libs/basis/')
    this.ktx2Loader.detectSupport(this.renderer)

    this.dracoLoader = new DRACOLoader()
    this.dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.4.3/')
    this.dracoLoader.preload()

    this.audio = audio ? audio : (document.createElement('audio') as HTMLAudioElement)

    this.vertexShader = `${ShaderChunk.common}
    ${ShaderChunk.logdepthbuf_pars_vertex}
    uniform vec2 size;
    out vec2 vUv;
    
    void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        vUv = uv;
        ${ShaderChunk.logdepthbuf_vertex}
    }`
    this.fragmentShader = `${ShaderChunk.logdepthbuf_pars_fragment}
    precision highp sampler2DArray;
    uniform sampler2DArray diffuse;
    in vec2 vUv;
    uniform int depth;
    out vec4 outColor;
    
    void main() {
        vec4 color = texture2D( diffuse, vec3( vUv, depth ) );
        outColor = LinearTosRGB(color);
        ${ShaderChunk.logdepthbuf_fragment}
    }`

    this.failMaterial = new MeshBasicMaterial({ color: 0xffffff })
  }

  get AudioURL(): string {
    if (!this.header || !this.header.output.audio) return null
    const path = this.header.output.audio.path.replace('[ext]', FORMATS_TO_EXT[this.header.output.audio.formats[0]])
    return path
  }

  private getGeometryURL = (frameNo: number) => {
    const targetData = this.header.output.geometry.targets[this.geometryTarget]
    const padWidth = countHashChar(this.header.output.geometry.path)

    const INPUTS = {
      '[target]': this.geometryTarget,
      '[ext]': FORMATS_TO_EXT[targetData.format]
    }
    INPUTS[`[${'#'.repeat(padWidth)}]`] = pad(frameNo, padWidth)
    let path = this.header.output.geometry.path
    Object.keys(INPUTS).forEach((key) => {
      path = path.replace(key, INPUTS[key])
    })
    return path
  }

  private getTextureURL = (segmentNo: number) => {
    const targetData = this.header.output.texture.targets[this.textureTarget]
    const padWidth = countHashChar(this.header.output.texture.path)
    const INPUTS = {
      '[target]': this.textureTarget,
      '[type]': this.textureType,
      '[tag]': this.textureTag,
      '[ext]': FORMATS_TO_EXT[targetData.format]
    }
    INPUTS[`[${'#'.repeat(padWidth)}]`] = pad(segmentNo, padWidth)

    const re = new RegExp(Object.keys(INPUTS).join('|'), 'gi')
    let path = this.header.output.texture.path
    Object.keys(INPUTS).forEach((key) => {
      path = path.replace(key, INPUTS[key])
    })
    return path
  }

  get paused(): boolean {
    if (this.AudioURL) {
      return this.audio.paused
    } else {
      return this.isClockPaused
    }
  }

  get GeometryFrameCount(): number {
    if (!this.header || !this.geometryTarget) return 0
    return this.header.output.geometry.targets[this.geometryTarget].frameCount
  }

  get BatchSize(): number {
    if (!this.header || !this.textureTarget) return 0
    return this.header.output.texture.targets[this.textureTarget].sequenceSize
  }

  get TextureSegmentCount(): number {
    if (!this.header || !this.textureTarget) return 0
    return this.header.output.texture.targets[this.textureTarget].sequenceCount
  }

  playTrack = (_fileHeader: V2FileHeader, _bufferDuration?: number, _intervalDuration?: number) => {
    this.header = _fileHeader
    this.geometryTarget = Object.keys(this.header.output.geometry.targets)[0]
    this.textureTarget = Object.keys(this.header.output.texture.targets)[0]

    if (_bufferDuration) {
      this.bufferDuration = _bufferDuration
    }

    if (_intervalDuration) {
      this.intervalDuration = _intervalDuration
    }

    if (this.AudioURL) {
      this.audio.src = this.AudioURL
      this.audio.currentTime = 0
    }

    this.lastRequestedGeometryFrame = -1
    this.lastRequestedTextureSegment = -1

    this.totalPausedDuration = 0
    this.isClockPaused = false
    this.pausedTime = 0
    this.currentTime = 0

    /**
     * fetch every 'intervalDuration' seconds. 'intervalDuration' is tightly coupled with bufferDuration.
     * If the bufferDuration is small, this intervalDuration should be small.
     * If bufferDuration is large, intervalDuration should be large as well to allow transcoding textures.
     */
    this.fetchBuffers(this.startVideo) /** Fetch initial buffers, and the start video */


    //@ts-ignore
    this.intervalId = setInterval(() => {
      this.fetchBuffers()
    }, this.intervalDuration * 1000) // seconds to milliseconds
  }

  startVideo = () => {
    if (this.AudioURL) {
      this.audio.play()
    } else {
      this.startTime = Date.now()
      this.isClockPaused = false
    }
  }

  /**
   * Fetches buffers according to Leaky Bucket algorithm.
   * If meshMap has less than required meshes, we keep fetching meshes. Otherwise, we keep fetching meshes.
   * Same goes for textures.
   */
  fetchBuffers = (callback?: fetchBuffersCallback) => {
    const promises = []

    // number of frames for 1 second
    const geometryBufferSize = this.header.output.geometry.targets[this.geometryTarget].frameRate
    const currentGeometryFrame = getCurrentFrame(
      this.header.output.geometry.targets[this.geometryTarget],
      this.currentTime
    )

    // number of segments for 1 second
    const textureBufferSize = Math.ceil(
      this.header.output.texture.targets[this.textureTarget].frameRate / this.BatchSize
    )
    const currentTextureFrame = getCurrentFrame(
      this.header.output.texture.targets[this.textureTarget],
      this.currentTime
    )
    const currentTextureSegment = Math.floor(currentTextureFrame / this.BatchSize)

    for (let i = 0; i < this.bufferDuration; i++) {
      if (
        this.lastRequestedGeometryFrame - currentGeometryFrame < this.bufferDuration * geometryBufferSize &&
        this.lastRequestedGeometryFrame != this.GeometryFrameCount - 1
      ) {
        let currentRequestingFrame = this.lastRequestedGeometryFrame + 1
        const currentRequestEnd = Math.min(
          currentGeometryFrame + (i + 1) * geometryBufferSize,
          this.GeometryFrameCount - 1
        )
        if (currentRequestEnd < currentRequestingFrame) continue
        this.lastRequestedGeometryFrame = currentRequestEnd
        for (; currentRequestingFrame <= this.lastRequestedGeometryFrame; currentRequestingFrame++) {
          const dracoURL = this.getGeometryURL(currentRequestingFrame)
          promises.push(this.decodeDraco(dracoURL, currentRequestingFrame))
        }
      }

      if (
        this.lastRequestedTextureSegment - currentTextureSegment < this.bufferDuration * textureBufferSize &&
        this.lastRequestedTextureSegment != this.TextureSegmentCount - 1
      ) {
        let currentRequestingTextureSegment = this.lastRequestedTextureSegment + 1
        const currentRequestEnd = Math.min(
          currentTextureSegment + (i + 1) * textureBufferSize,
          this.TextureSegmentCount - 1
        )
        if (currentRequestEnd < currentRequestingTextureSegment) continue
        this.lastRequestedTextureSegment = currentRequestEnd
        for (; currentRequestingTextureSegment <= this.lastRequestedTextureSegment; currentRequestingTextureSegment++) {
          const textureURL = this.getTextureURL(currentRequestingTextureSegment)
          promises.push(this.decodeKTX2(textureURL, currentRequestingTextureSegment))
        }
      }
    }

    if (callback) {
      Promise.all(promises).then(() => {
        callback()
      })
    }
  }

  decodeDraco = (dracoURL: string, frameNo: number) => {
    return new Promise((resolve, reject) => {
      this.dracoLoader.load(dracoURL, (geometry: BufferGeometry) => {
        this.meshMap.set(frameNo, geometry)
        resolve(true)
      })
    })
  }

  decodeKTX2 = (textureURL: string, segmentNo: number) => {
    return new Promise((resolve, reject) => {
      this.ktx2Loader.load(textureURL, (texture: CompressedArrayTexture) => {
        this.textureMap.set(segmentNo, texture)
        resolve(true)
      })
    })
  }

  pause = () => {
    if (this.AudioURL) {
      this.audio.pause()
    } else {
      this.isClockPaused = true
      this.pausedTime = Date.now()
    }
  }

  play = () => {
    if (this.AudioURL) {
      this.audio.play()
    } else {
      if (this.isClockPaused) {
        this.totalPausedDuration += Date.now() - this.pausedTime
        this.isClockPaused = false
      }
    }
  }

  processFrame = () => {
    if (!this.header) {
      return
    }

    const gFrameRate = this.header.output.geometry.targets[this.geometryTarget].frameRate

    if (this.AudioURL && this.audio.ended) {
      clearInterval(this.intervalId)
      this.dispose(false) // next track might be using this compiled shader
      this.onTrackEnd()
      return
    }

    if (this.paused) {
      /**
       * Usually, this case arises when new track is set and fetchBuffers is still loading next frames.
       * Until, startVideo is called, this.paused stays true.
       */
      this.onMeshBuffering?.(this.meshMap.size / (gFrameRate * this.bufferDuration))
      return
    }

    if (this.AudioURL) {
      this.currentTime = this.audio.currentTime
    } else {
      const currentTimeMS = Date.now() - this.startTime - this.totalPausedDuration
      this.currentTime = currentTimeMS / 1000
    }

    const currentGeometryFrame = getCurrentFrame(
      this.header.output.geometry.targets[this.geometryTarget],
      this.currentTime
    )
    const currentTextureFrame = getCurrentFrame(
      this.header.output.texture.targets[this.textureTarget],
      this.currentTime
    )
    const currentTextureSegment = Math.floor(currentTextureFrame / this.BatchSize)

    if (currentGeometryFrame >= this.GeometryFrameCount) {
      clearInterval(this.intervalId)
      this.dispose(false) // next track might be using this compiled shader, so dont dispose shader
      this.onTrackEnd()
      return
    }

    /**
     * We prioritize geometry frames over texture frames.
     * If meshMap does not have the geometry frame, simply skip it
     * If meshMap has geometry frame but not the texture segment, a default failMaterial is applied to that mesh.
     */

    if (!this.meshMap.has(currentGeometryFrame)) {
      return
    }

    if (!this.textureMap.has(currentTextureSegment)) {
      this.mesh.geometry = this.meshMap.get(currentGeometryFrame)
      this.mesh.material = this.failMaterial
      this.onFrameShow?.(currentGeometryFrame)
      return
    }

    const offSet = currentTextureFrame % this.BatchSize

    this.onFrameShow?.(currentGeometryFrame)

    if (
      offSet == 0 ||
      // @ts-ignore
      !this.mesh.material.isShaderMaterial ||
      // @ts-ignore
      this.mesh.material.name != currentTextureSegment
    ) {
      /**
       * Either this is a new segment, hence we need to apply a new texture
       * Or In the previous frame, we applied to failMaterial, so that current mesh.material is not a ShaderMaterial.
       * Or Player skipped current segment's first frame hence it has old segment's ShaderMaterial
       * In all the above cases, we need to apply new texture since we know we have one.
       */

      if ((this.mesh.material as ShaderMaterial).isShaderMaterial) {
        // If we already have ShaderMaterial, just update uniforms
        ;(this.mesh.material as ShaderMaterial).uniforms.diffuse.value = this.textureMap.get(currentTextureSegment)
        ;(this.mesh.material as ShaderMaterial).uniforms.depth.value = offSet
      } else if (this.shaderMaterial) {
        /**
         * Mesh doesn't have ShaderMaterial (probably it used failMaterial before)
         * But we have cached shaderMaterial, update uniforms and use it.
         */
        this.shaderMaterial.uniforms.diffuse.value = this.textureMap.get(currentTextureSegment)
        this.shaderMaterial.uniforms.depth.value = offSet
        this.mesh.material = this.shaderMaterial
      } else {
        // We have nothing. Create material, Cache it and assign it.
        this.shaderMaterial = new ShaderMaterial({
          uniforms: {
            diffuse: {
              value: this.textureMap.get(currentTextureSegment)
            },
            depth: {
              value: offSet
            }
          },
          vertexShader: this.vertexShader,
          fragmentShader: this.fragmentShader,
          glslVersion: GLSL3
        })
        this.mesh.material = this.shaderMaterial
      }

      // @ts-ignore
      this.mesh.material.name = currentTextureSegment.toString()
      // @ts-ignore
      this.mesh.material.needsUpdate = true
      this.mesh.geometry = this.meshMap.get(currentGeometryFrame)
      this.mesh.geometry.attributes.position.needsUpdate = true
    } else {
      this.mesh.geometry = this.meshMap.get(currentGeometryFrame)
      if (this.mesh.geometry) {
        this.mesh.geometry.attributes.position.needsUpdate = true
      }
      // updating texture within CompressedArrayTexture
      ;(this.mesh.material as ShaderMaterial).uniforms['depth'].value = offSet
    }
  }

  removePlayedBuffer(frameNo, segmentNo) {
    for (const [key, buffer] of this.meshMap.entries()) {
      if (key < frameNo) {
        buffer.dispose()
        this.meshMap.delete(key)
      }
    }

    for (const [key, buffer] of this.textureMap.entries()) {
      if (key < segmentNo) {
        buffer.dispose()
        this.textureMap.delete(key)
      }
    }
  }

  update = () => {
    if (!this.header) {
      return
    }
    this.processFrame()
    const currentGeometryFrame = getCurrentFrame(
      this.header.output.geometry.targets[this.geometryTarget],
      this.currentTime
    )
    const currentTextureFrame = getCurrentFrame(
      this.header.output.texture.targets[this.textureTarget],
      this.currentTime
    )
    const currentTextureSegment = Math.floor(currentTextureFrame / this.BatchSize)
    this.removePlayedBuffer(currentGeometryFrame - 5, currentTextureSegment - 1)
  }

  dispose(disposeShader = true): void {
    if (this.meshMap) {
      for (let i = 0; i < this.meshMap.size; i++) {
        const buffer = this.meshMap.get(i)
        if (buffer && buffer instanceof BufferGeometry) {
          buffer.dispose()
        }
      }
      this.meshMap.clear()
    }

    if (this.textureMap) {
      for (let i = 0; i < this.textureMap.size; i++) {
        const buffer = this.textureMap.get(i)
        if (buffer && buffer instanceof CompressedArrayTexture) {
          buffer.dispose()
        }
      }
      this.textureMap.clear()
    }
    if (disposeShader && this.shaderMaterial) {
      this.shaderMaterial.dispose()
    }
  }
}
