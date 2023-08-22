import ManyKeysMap from 'many-keys-map'
import {
  Box3,
  BufferGeometry,
  Color,
  CompressedPixelFormat,
  Material,
  Mesh,
  MeshBasicMaterial,
  Sphere,
  Texture,
  Vector3,
  WebGLRenderer
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader'
import { KTXLoader } from 'three/examples/jsm/loaders/KTXLoader'

import {
  ASTC_BLOCK_SIZE_TO_FORMAT,
  GEOMETRY_FORMAT_PRIORITY,
  GLBEncodeOptions,
  onFrameShowCallback,
  onMeshBufferingCallback,
  onTrackEndCallback,
  TextureType,
  V2Schema
} from '../Interfaces'
import { FORMATS_TO_EXT, TEXTURE_FORMAT_PRIORITY } from '../Interfaces'
import {
  GeometryFrameCount as _GeometryFrameCount,
  TextureFrameCount as _TextureFrameCount,
  calculateGeometryFrame,
  calculateTextureFrame,
  decodeGeometry,
  decodeTexture,
  getAbsoluteURL,
  getGeometryURL,
  getTextureURL,
  isTextureFormatSupported,
  updateGeometry,
  updateTexture
} from './utils'

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

export default class Player {
  // Player fields
  public renderer: WebGLRenderer
  public bufferDuration = 4 // in seconds. Player tries to store frames sufficient to play these many seconds
  public intervalDuration = 2 // number of seconds between fetchBuffers calls
  public mesh: Mesh

  private audio: HTMLAudioElement | HTMLVideoElement
  private gltfLoader: GLTFLoader
  private meshoptDecoder: typeof MeshoptDecoder
  private dracoLoader: DRACOLoader
  private ktxLoader: KTXLoader
  private ktx2Loader: KTX2Loader
  private meshMaterial: Material
  private failMaterial: Material
  private meshMap: ManyKeysMap<[string, number], BufferGeometry> = new ManyKeysMap() // (Target, FrameNo) => BufferGeometry
  private textureMap: ManyKeysMap<[TextureType, string, string, number], Texture> = new ManyKeysMap() // (Type, Tag, Target, FrameNo) => Texture

  private onMeshBuffering: onMeshBufferingCallback | null = null
  private onFrameShow: onFrameShowCallback | null = null
  private onTrackEnd: onTrackEndCallback | null = null

  private trackData:
    | {
        manifestPath: string
        manifest: V2Schema
        hasAudio: boolean

        // Target => FrameNo
        lastRequestedGeometryFrame: Partial<Record<string, number>>

        // Type => (Target => FrameNo)
        // All tags maintain same frame numbers, frame counts and frame rates
        lastRequestedTextureFrame: Partial<Record<TextureType, Partial<Record<string, number>>>>

        geometryTargets: string[]
        currentGeometryTarget: string

        // cache
        boundingBox: Box3 | null
        boundingSphere: Sphere | null

        textureTypes: TextureType[]
        textureTargets: Partial<Record<TextureType, string[]>>
        textureTags: Partial<Record<TextureType, string[]>>
        currentTextureTarget: Partial<Record<TextureType, string>>
        currentTextureTag: Partial<Record<TextureType, string>>

        intervalId: number

        stats: number[]
      }
    | undefined

  private timeData:
    | {
        currentTime: number
        startTime: number
        pausedTime: number
        totalPausedDuration: number
        isClockPaused: boolean
      }
    | undefined

  constructor({ renderer, onMeshBuffering, onFrameShow, mesh, onTrackEnd, audio }: PlayerConstructorArgs) {
    this.renderer = renderer

    /* This property is used by the parent components and rendered on the scene */
    this.mesh = mesh

    this.onMeshBuffering = onMeshBuffering
    this.onFrameShow = onFrameShow
    this.onTrackEnd = onTrackEnd

    this.audio = audio ? audio : (document.createElement('audio') as HTMLAudioElement)

    this.dracoLoader = new DRACOLoader()
    this.dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.4.3/')
    this.dracoLoader.preload()

    this.ktxLoader = new KTXLoader()

    this.ktx2Loader = new KTX2Loader()
    this.ktx2Loader.setTranscoderPath('https://unpkg.com/three@0.153.0/examples/jsm/libs/basis/')
    this.ktx2Loader.detectSupport(this.renderer)

    this.meshoptDecoder = MeshoptDecoder
    // @ts-ignore
    this.meshoptDecoder.useWorkers(4)
    this.gltfLoader = new GLTFLoader().setMeshoptDecoder(this.meshoptDecoder)

    // this.failMaterial = new MeshPhongMaterial({
    //   color: new Color(0x049ef4),
    //   emissive: new Color(0x000000),
    //   specular: new Color(0x111111),
    //   shininess: 100,
    //   reflectivity: 1,
    //   refractionRatio: 1
    // })
    this.failMaterial = new MeshBasicMaterial({ color: new Color(0x049ef4) })
    this.meshMaterial = (this.mesh.material as Material).clone()
    console.log(this.meshMaterial)
  }

  get paused() {
    if (this.trackData === undefined || this.timeData === undefined) {
      return true
    }
    if (this.trackData.hasAudio) {
      return this.audio.paused
    } else {
      return this.timeData.isClockPaused
    }
  }

  private currentGeometryFrame() {
    const currentTarget = this.trackData.currentGeometryTarget
    return calculateGeometryFrame(this.trackData.manifest, currentTarget, this.timeData.currentTime)
  }

  private GeometryFrameCount() {
    const currentTarget = this.trackData.currentGeometryTarget
    return _GeometryFrameCount(this.trackData.manifest, currentTarget)
  }

  private currentTextureFrame(textureType: TextureType) {
    const currentTarget = this.trackData.currentTextureTarget[textureType]
    return calculateTextureFrame(this.trackData.manifest, textureType, currentTarget, this.timeData.currentTime)
  }

  /**
   * Only consider 'baseColor' for frameCount.
   * Others are not as important as 'baseColor'.
   */
  private TextureFrameCount(textureType: TextureType = 'baseColor') {
    const currentTarget = this.trackData.currentTextureTarget[textureType]
    return _TextureFrameCount(this.trackData.manifest, textureType, currentTarget)
  }

  playTrack = (_manifest: V2Schema, _manifestFilePath: string, _bufferDuration: number, _intervalDuration: number) => {
    const hasAudio = typeof _manifest.audio !== 'undefined' && _manifest.audio.path.length > 0

    /**
     * TODO: Adaptive geometry target selection
     */
    const geometryTargets = Object.keys(_manifest.geometry.targets)
    geometryTargets.sort((a, b) => {
      const aFormat = _manifest.geometry.targets[a].format
      const bFormat = _manifest.geometry.targets[b].format
      const aPriority = GEOMETRY_FORMAT_PRIORITY[aFormat]
      const bPriority = GEOMETRY_FORMAT_PRIORITY[bFormat]
      if (aPriority !== bPriority) {
        return bPriority - aPriority
      }
      if (aFormat === 'glb' && bFormat === 'glb') {
        const aRatio = (_manifest.geometry.targets[a].settings as GLBEncodeOptions).simplificationRatio ?? 1
        const bRatio = (_manifest.geometry.targets[b].settings as GLBEncodeOptions).simplificationRatio ?? 1
        if (aRatio !== bRatio) {
          return bRatio - aRatio
        }
      }

      const aFrameRate = _manifest.geometry.targets[a].frameRate
      const bFrameRate = _manifest.geometry.targets[b].frameRate
      return aFrameRate - bFrameRate
    })

    const currentGeometryTarget = geometryTargets[0]

    const textureTypes: TextureType[] = []
    Object.keys(_manifest.texture).forEach((textureType) => {
      if (textureType !== 'path') textureTypes.push(textureType as TextureType)
    })

    const textureTargets: Partial<Record<TextureType, string[]>> = {}
    textureTypes.forEach((textureType) => {
      const allTargets = Object.keys(_manifest.texture[textureType as TextureType].targets)
      const supportedTargets: string[] = []
      allTargets.forEach((target) => {
        const format = _manifest.texture[textureType as TextureType].targets[target].format
        if (isTextureFormatSupported(this.renderer, format)) {
          supportedTargets.push(target)
        }
      })

      supportedTargets.sort((a, b) => {
        const aResolution = _manifest.texture[textureType as TextureType].targets[a].settings.resolution
        const bResolution = _manifest.texture[textureType as TextureType].targets[b].settings.resolution
        const aFrameRate = _manifest.texture[textureType as TextureType].targets[a].frameRate
        const bFrameRate = _manifest.texture[textureType as TextureType].targets[b].frameRate
        const aFormat = _manifest.texture[textureType as TextureType].targets[a].format
        const bFormat = _manifest.texture[textureType as TextureType].targets[b].format
        const aPriority = TEXTURE_FORMAT_PRIORITY[aFormat]
        const bPriority = TEXTURE_FORMAT_PRIORITY[bFormat]
        const aPixelPerSecond = aResolution.width * aResolution.height * aFrameRate
        const bPixelPerSecond = bResolution.width * bResolution.height * bFrameRate

        /**
         * Sort by priority first
         */
        if (aPriority !== bPriority) {
          return bPriority - aPriority
        }

        return aPixelPerSecond - bPixelPerSecond
      })

      textureTargets[textureType] = supportedTargets
    })
    console.log(textureTargets)

    const currentTextureTarget: Partial<Record<TextureType, string>> = {}

    Object.keys(textureTargets).forEach((textureType) => {
      currentTextureTarget[textureType as TextureType] = textureTargets[textureType as TextureType][0]
    })

    const textureTags: Partial<Record<TextureType, string[]>> = {}
    textureTypes.forEach((textureType) => {
      const _input = _manifest.input.texture[textureType as TextureType]
      const inputs = Array.isArray(_input) ? _input : [_input]
      textureTags[textureType] = []

      inputs.forEach((input) => {
        if (typeof input.tag !== 'undefined') {
          textureTags[textureType].push(input.tag)
        }
      })

      if (textureTags[textureType].length === 0) {
        textureTags[textureType].push('default')
      }
    })

    /**
     * For now choose the first tag
     * TODO: User driven tag selection
     */
    const currentTextureTag: Partial<Record<TextureType, string>> = {}
    Object.keys(textureTags).forEach((textureType) => {
      currentTextureTag[textureType as TextureType] = textureTags[textureType as TextureType][0]
    })

    const lastRequestedGeometryFrame: Partial<Record<string, number>> = {}
    geometryTargets.forEach((target) => {
      lastRequestedGeometryFrame[target] = -1
    })

    const lastRequestedTextureFrame: Partial<Record<TextureType, Partial<Record<string, number>>>> = {}
    Object.keys(textureTargets).forEach((textureType) => {
      lastRequestedTextureFrame[textureType as TextureType] = {}
      textureTargets[textureType as TextureType].forEach((target) => {
        lastRequestedTextureFrame[textureType as TextureType][target] = -1
      })
    })

    this.trackData = {
      manifestPath: _manifestFilePath,
      manifest: _manifest,
      hasAudio: hasAudio,
      lastRequestedGeometryFrame: lastRequestedGeometryFrame,
      lastRequestedTextureFrame: lastRequestedTextureFrame,
      geometryTargets: geometryTargets,
      textureTargets: textureTargets,
      textureTags: textureTags,
      textureTypes: textureTypes,
      currentGeometryTarget: currentGeometryTarget,
      boundingBox: null,
      boundingSphere: null,
      currentTextureTarget: currentTextureTarget,
      currentTextureTag: currentTextureTag,
      intervalId: -1, // Set this below
      stats: []
    }

    console.log(this.trackData)

    this.timeData = {
      currentTime: 0,
      startTime: -1,
      pausedTime: 0,
      totalPausedDuration: 0,
      isClockPaused: true
    }

    this.bufferDuration = _bufferDuration
    this.intervalDuration = _intervalDuration

    if (this.trackData.hasAudio) {
      let audioURL = this.trackData.manifest.audio.path
      const formats = this.trackData.manifest.audio.formats

      /* Pick the first  supported audio format */
      const supportedFormat = formats.find((format) => {
        return this.audio.canPlayType(`audio/${format}`) !== ''
      })

      if (supportedFormat !== undefined) {
        audioURL = audioURL.replace('[ext]', FORMATS_TO_EXT[supportedFormat])
        this.audio.src = getAbsoluteURL(this.trackData.manifestPath, audioURL)
      } else {
        console.error('No supported audio format found. Playing UVOL without audio')
        this.trackData.hasAudio = false
      }
    }

    /**
     * fetch every 'intervalDuration' seconds. 'intervalDuration' is tightly coupled with bufferDuration.
     * If the bufferDuration is small, this intervalDuration should be small.
     * If bufferDuration is large, intervalDuration should be large as well to allow transcoding textures.
     */
    this.fetchBuffers(this.startVideo) /** Fetch initial buffers, and the start video */

    // @ts-ignore
    this.trackData.intervalId = setInterval(this.fetchBuffers, this.intervalDuration * 1000) // seconds to milliseconds
  }

  startVideo = () => {
    if (this.trackData.hasAudio) {
      this.audio.play()
    } else {
      this.timeData.startTime = Date.now()
      this.timeData.isClockPaused = false
    }
  }

  fetchGeometry = async (gTarget: string, frameNo: number) => {
    const geometryURL = getGeometryURL(this.trackData.manifest, this.trackData.manifestPath, gTarget, frameNo)
    const geometry = await decodeGeometry(
      this.dracoLoader,
      this.gltfLoader,
      this.trackData.manifest.geometry.targets[gTarget].format,
      geometryURL
    )

    if (!this.trackData.boundingBox) {
      geometry.computeBoundingBox()

      const center = new Vector3()
      geometry.boundingBox.getCenter(center)

      const size = new Vector3()
      geometry.boundingBox.getSize(size)
      size.multiplyScalar(1.1) // Increasing size by 10%

      this.trackData.boundingBox = geometry.boundingBox.setFromCenterAndSize(center, size)
    }
    geometry.boundingBox = this.trackData.boundingBox

    if (!this.trackData.boundingSphere) {
      geometry.computeBoundingSphere()
      const center = geometry.boundingSphere.center
      const radius = geometry.boundingSphere.radius * 1.1 // Increasing radius by 10%
      this.trackData.boundingSphere = geometry.boundingSphere.set(center, radius)
    }
    geometry.boundingSphere = this.trackData.boundingSphere

    this.meshMap.set([gTarget, frameNo], geometry)
  }

  fetchTexture = async (textureType: TextureType, textureTag: string, textureTarget: string, frameNo: number) => {
    const textureURL = getTextureURL(
      this.trackData.manifest,
      this.trackData.manifestPath,
      textureType,
      textureTag,
      textureTarget,
      frameNo
    )
    const targetData = this.trackData.manifest.texture[textureType].targets[textureTarget]
    const format = targetData.format
    let astcFormat: CompressedPixelFormat | undefined
    if (format === 'astc/ktx') {
      astcFormat = ASTC_BLOCK_SIZE_TO_FORMAT[targetData.settings.blocksize]
    }
    const texture = await decodeTexture(this.ktx2Loader, this.ktxLoader, targetData.format, textureURL, astcFormat)
    this.textureMap.set([textureType, textureTag, textureTarget, frameNo], texture)
  }

  /**
   * Fetches buffers according to Leaky Bucket algorithm.
   * If meshMap has less than required meshes, we keep fetching meshes. Otherwise, we keep fetching meshes.
   * Same goes for textures.
   */
  fetchBuffers = (callback?: fetchBuffersCallback) => {
    const promises = []

    const gTarget = this.trackData.currentGeometryTarget

    const oldLastGeometryFrame = this.trackData.lastRequestedGeometryFrame[gTarget]
    const startTime = Date.now()

    const currentGFrame = this.currentGeometryFrame()
    const gFramesPerSecond = this.trackData.manifest.geometry.targets[this.trackData.currentGeometryTarget].frameRate

    const tTarget: Partial<Record<TextureType, string>> = {}
    this.trackData.textureTypes.forEach((textureType) => {
      tTarget[textureType as TextureType] = this.trackData.currentTextureTarget[textureType as TextureType]
    })

    // All tags belong to particualar texture type has the same target
    // Hence same frameRate and frameCount. So, it's enough to get the currentFrame for a type
    const currentTFrame: Partial<Record<TextureType, number>> = {}
    this.trackData.textureTypes.forEach((textureType) => {
      currentTFrame[textureType as TextureType] = this.currentTextureFrame(textureType as TextureType)
    })

    const tFramesPerSecond: Partial<Record<TextureType, number>> = {}
    this.trackData.textureTypes.forEach((textureType) => {
      const target = this.trackData.currentTextureTarget[textureType as TextureType]
      tFramesPerSecond[textureType as TextureType] =
        this.trackData.manifest.texture[textureType as TextureType].targets[target].frameRate
    })

    for (let i = 0; i < this.bufferDuration; i++) {
      const geometryRequestEnd = Math.min(currentGFrame + (i + 1) * gFramesPerSecond, this.GeometryFrameCount() - 1)

      if (
        this.trackData.lastRequestedGeometryFrame[gTarget] != this.GeometryFrameCount() - 1 &&
        this.trackData.lastRequestedGeometryFrame[gTarget] < geometryRequestEnd
      ) {
        let currentRequestingFrame = this.trackData.lastRequestedGeometryFrame[gTarget] + 1
        this.trackData.lastRequestedGeometryFrame[gTarget] = geometryRequestEnd
        for (; currentRequestingFrame <= geometryRequestEnd; currentRequestingFrame++) {
          promises.push(this.fetchGeometry(gTarget, currentRequestingFrame))
        }
      }

      this.trackData.textureTypes.forEach((textureType) => {
        const currentTarget = tTarget[textureType]
        const currentTag = this.trackData.currentTextureTag[textureType]

        const textureRequestEnd = Math.min(
          currentTFrame[textureType] + (i + 1) * tFramesPerSecond[textureType],
          this.TextureFrameCount(textureType) - 1
        )
        if (
          this.trackData.lastRequestedTextureFrame[textureType][currentTarget] !=
            this.TextureFrameCount(textureType) - 1 &&
          this.trackData.lastRequestedTextureFrame[textureType][currentTarget] < textureRequestEnd
        ) {
          let currentRequestingFrame = this.trackData.lastRequestedTextureFrame[textureType][currentTarget] + 1
          this.trackData.lastRequestedTextureFrame[textureType][currentTarget] = textureRequestEnd
          for (; currentRequestingFrame <= textureRequestEnd; currentRequestingFrame++) {
            promises.push(this.fetchTexture(textureType, currentTag, currentTarget, currentRequestingFrame))
          }
        }
      })
    }

    Promise.all(promises).then(() => {
      const endTime = Date.now()
      const fetchedFrames = this.trackData.lastRequestedGeometryFrame[gTarget] - oldLastGeometryFrame
      const playTime = fetchedFrames / gFramesPerSecond
      const fetchTime = (endTime - startTime) / 1000
      if (playTime > 0) {
        this.trackData.stats.push(fetchTime / playTime)
        this.adjustTextureTarget()
      }

      if (callback) {
        console.log('Initial buffers fetched. Starting playback...')
        callback()
      }
    })
  }

  adjustTextureTarget = () => {
    if (this.trackData.stats.length < 3) return
    const mean = this.trackData.stats.reduce((a, b) => a + b, 0) / this.trackData.stats.length

    if (0 <= mean && mean <= 0.3) {
      // Probably very comfortably at current target.
      // Lets try to increase the target
      const currentTargetIndex = this.trackData.textureTargets['baseColor'].indexOf(
        this.trackData.currentTextureTarget['baseColor']
      )
      if (currentTargetIndex < this.trackData.textureTargets['baseColor'].length - 1) {
        this.trackData.currentTextureTarget['baseColor'] =
          this.trackData.textureTargets['baseColor'][currentTargetIndex + 1]
        console.log('Updated target to : ', this.trackData.currentTextureTarget['baseColor'])
      }
    } else if (0.3 <= mean && mean <= 0.6) {
      // Probably at the edge of current target.
      // Do not change target
    } else {
      // Struggling to keep up with current target.
      // Lets try to decrease the target
      const currentTargetIndex = this.trackData.textureTargets['baseColor'].indexOf(
        this.trackData.currentTextureTarget['baseColor']
      )
      if (currentTargetIndex > 0) {
        this.trackData.currentTextureTarget['baseColor'] =
          this.trackData.textureTargets['baseColor'][currentTargetIndex - 1]
        console.log('Updated target to : ', this.trackData.currentTextureTarget['baseColor'])
      }
    }

    this.trackData.stats.length = 0
  }

  pause = () => {
    if (this.trackData.hasAudio) {
      this.audio.pause()
    } else {
      this.timeData.isClockPaused = true
      this.timeData.pausedTime = Date.now()
    }
  }

  play = () => {
    if (this.trackData.hasAudio) {
      this.audio.play()
    } else {
      if (this.timeData.isClockPaused) {
        this.timeData.totalPausedDuration += Date.now() - this.timeData.pausedTime
        this.timeData.isClockPaused = false
      }
    }
  }

  updateMaterial(material: Material) {
    if ((this.mesh.material as Material).uuid != material.uuid) {
      this.mesh.material = material
      this.mesh.material.needsUpdate = true
    }
  }

  processFrame = () => {
    if (this.paused) {
      this.onMeshBuffering?.(0)
      return
    }

    if (this.trackData.hasAudio && this.audio.ended) {
      clearInterval(this.trackData.intervalId)
      this.dispose(false) // dont dispose loaders
      this.onTrackEnd()
      return
    }

    if (this.trackData.hasAudio) {
      this.timeData.currentTime = this.audio.currentTime
    } else {
      const currentTimeMS = Date.now() - this.timeData.startTime - this.timeData.totalPausedDuration
      this.timeData.currentTime = currentTimeMS / 1000
    }

    const currentGeometryFrame = this.currentGeometryFrame()
    const currentTextureFrame = this.currentTextureFrame('baseColor') /* Currently only dealing with baseColor */
    const textureTarget = this.trackData.currentTextureTarget['baseColor']
    const textureTag = this.trackData.currentTextureTag['baseColor']

    this.removePlayedGeometryBuffer([this.trackData.currentGeometryTarget, currentGeometryFrame - 1])
    this.removePlayedTextureBuffer(['baseColor', textureTag, textureTarget, currentTextureFrame - 1])

    if (currentGeometryFrame >= this.GeometryFrameCount() - 1) {
      clearInterval(this.trackData.intervalId)
      this.dispose(false) // dont dispose loaders
      this.timeData.isClockPaused = true
      this.onTrackEnd()
      return
    }

    /**
     * We prioritize geometry frames over texture frames.
     * If meshMap does not have the geometry frame, simply skip it
     * If meshMap has geometry frame but not the texture segment, a default failMaterial is applied to that mesh.
     */

    if (!this.meshMap.has([this.trackData.currentGeometryTarget, currentGeometryFrame])) {
      return
    }

    if (!this.textureMap.has(['baseColor', textureTag, textureTarget, currentTextureFrame])) {
      updateGeometry(this.mesh, this.meshMap.get([this.trackData.currentGeometryTarget, currentGeometryFrame]))

      // If texture is not available, search for other targets in defaultTag.
      // Reasoning: Applying a known tag is better than applying failMaterial
      const fallbackTag = 'default'

      for (let i = 0; i < this.trackData.textureTargets.baseColor.length; i++) {
        const target = this.trackData.textureTargets.baseColor[i]
        const failCurrentTextureFrame = calculateTextureFrame(
          this.trackData.manifest,
          'baseColor',
          target,
          this.timeData.currentTime
        )
        if (this.textureMap.has(['baseColor', fallbackTag, target, failCurrentTextureFrame])) {
          updateTexture(
            this.mesh,
            this.textureMap.get(['baseColor', fallbackTag, target, failCurrentTextureFrame]),
            this.meshMaterial,
            this.failMaterial
          )
          this.onFrameShow?.(currentGeometryFrame)
          return
        }
      }

      // If player reached here, it did not find texture in any target. So, apply failMaterial
      this.updateMaterial(this.failMaterial)
      this.onFrameShow?.(currentGeometryFrame)
      return
    } else {
      updateGeometry(this.mesh, this.meshMap.get([this.trackData.currentGeometryTarget, currentGeometryFrame]))
      updateTexture(
        this.mesh,
        this.textureMap.get(['baseColor', textureTag, textureTarget, currentTextureFrame]),
        this.meshMaterial,
        this.failMaterial
      )
      this.onFrameShow?.(currentGeometryFrame)
    }
  }

  update = () => {
    if (!this.trackData) {
      return
    }
    this.processFrame()
  }

  removePlayedGeometryBuffer = (key: [target: string, frameNo: number]) => {
    if (this.meshMap.has(key)) {
      const buffer = this.meshMap.get(key)
      buffer.dispose()
      this.meshMap.delete(key)
    }
  }

  removePlayedTextureBuffer = (key: [textureType: TextureType, tag: string, target: string, frameNo: number]) => {
    if (this.textureMap.has(key)) {
      const buffer = this.textureMap.get(key)
      buffer.dispose()
      this.textureMap.delete(key)
    }
  }

  dispose(disposeLoaders = true): void {
    for (const [key, buffer] of this.meshMap.entries()) {
      this.meshMap.delete(key)
      if (buffer && buffer instanceof BufferGeometry) {
        buffer.dispose()
      }
    }
    this.meshMap.clear()

    for (const [key, buffer] of this.textureMap.entries()) {
      this.textureMap.delete(key)
      if (buffer && buffer.isTexture) {
        buffer.dispose()
      }
    }
    this.textureMap.clear()

    if (disposeLoaders) {
      console.log('Disposing Loaders')
      this.dracoLoader.dispose()
      this.ktx2Loader.dispose()
    }
  }
}
