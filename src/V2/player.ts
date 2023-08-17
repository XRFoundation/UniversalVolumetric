import ManyKeysMap from 'many-keys-map'
import {
  Box3,
  BufferGeometry,
  Color,
  CompressedTexture,
  Material,
  Mesh,
  MeshBasicMaterial,
  Sphere,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer
} from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader'
import { KTXLoader } from 'three/examples/jsm/loaders/KTXLoader'

import {
  ASTC_BLOCK_SIZE_TO_FORMAT,
  ASTCTextureTarget,
  onFrameShowCallback,
  onMeshBufferingCallback,
  onTrackEndCallback,
  TextureType,
  V2Schema
} from '../Interfaces'
import { FORMATS_TO_EXT, TEXTURE_FORMAT_PRIORITY } from '../Interfaces'
import { countHashChar, getAbsoluteURL, isTextureFormatSupported, pad } from '../utils'

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
  private dracoLoader: DRACOLoader
  private ktxLoader: KTXLoader
  private ktx2Loader: KTX2Loader
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

    // this.failMaterial = new MeshPhongMaterial({
    //   color: new Color(0x049ef4),
    //   emissive: new Color(0x000000),
    //   specular: new Color(0x111111),
    //   shininess: 100,
    //   reflectivity: 1,
    //   refractionRatio: 1
    // })
    this.failMaterial = new MeshBasicMaterial({ color: new Color(0x049ef4) })
  }

  private getGeometryURL = (frameNo: number) => {
    const targetData = this.trackData.manifest.geometry.targets[this.trackData.currentGeometryTarget]
    let path = this.trackData.manifest.geometry.path
    const padWidth = countHashChar(path)
    const TEMPLATE_MAP = {
      '[target]': this.trackData.currentGeometryTarget,
      '[ext]': FORMATS_TO_EXT[targetData.format]
    }
    TEMPLATE_MAP[`[${'#'.repeat(padWidth)}]`] = pad(frameNo, padWidth)
    Object.keys(TEMPLATE_MAP).forEach((key) => {
      path = path.replace(key, TEMPLATE_MAP[key])
    })
    return getAbsoluteURL(this.trackData.manifestPath, path)
  }

  private getTextureURL = (frameNo: number, textureType: TextureType) => {
    const target = this.trackData.currentTextureTarget[textureType]
    const tag = this.trackData.currentTextureTag[textureType]

    const targetData = this.trackData.manifest.texture[textureType].targets[target]
    let path = this.trackData.manifest.texture.path
    const padWidth = countHashChar(path)
    const TEMPLATE_MAP = {
      '[target]': target,
      '[type]': textureType as string,
      '[tag]': tag,
      '[ext]': FORMATS_TO_EXT[targetData.format]
    }
    TEMPLATE_MAP[`[${'#'.repeat(padWidth)}]`] = pad(frameNo, padWidth)

    Object.keys(TEMPLATE_MAP).forEach((key) => {
      path = path.replace(key, TEMPLATE_MAP[key])
    })
    return getAbsoluteURL(this.trackData.manifestPath, path)
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

  private calculateGeometryFrame(gTarget: string) {
    const targetData = this.trackData.manifest.geometry.targets[gTarget]
    const frameRate = targetData.frameRate
    return Math.round(this.timeData.currentTime * frameRate)
  }

  private currentGeometryFrame() {
    const currentTarget = this.trackData.currentGeometryTarget
    return this.calculateGeometryFrame(currentTarget)
  }

  private GeometryFrameCount() {
    const currentTarget = this.trackData.currentGeometryTarget
    const targetData = this.trackData.manifest.geometry.targets[currentTarget]
    return targetData.frameCount ?? 0
  }

  private calculateTextureFrame(textureType: TextureType, tTarget: string) {
    const targetData = this.trackData.manifest.texture[textureType].targets[tTarget]
    const frameRate = targetData.frameRate
    return Math.round(this.timeData.currentTime * frameRate)
  }

  private currentTextureFrame(textureType: TextureType) {
    const currentTarget = this.trackData.currentTextureTarget[textureType]
    return this.calculateTextureFrame(textureType, currentTarget)
  }

  /**
   * Only consider 'baseColor' for frameCount.
   * Others are not as important as 'baseColor'.
   */
  private TextureFrameCount(textureType: TextureType = 'baseColor') {
    const currentTarget = this.trackData.currentTextureTarget[textureType]
    const targetData = this.trackData.manifest.texture.baseColor.targets[currentTarget]
    return targetData.frameCount ?? 0
  }

  playTrack = (_manifest: V2Schema, _manifestFilePath: string, _bufferDuration: number, _intervalDuration: number) => {
    const hasAudio = typeof _manifest.audio !== 'undefined' && _manifest.audio.path.length > 0

    const geometryTargets = Object.keys(_manifest.geometry.targets)

    /**
     * For now choose the target with lowest frameRate
     * TODO: Adaptive target selection
     */
    const currentGeometryTarget = geometryTargets.reduce((prev, curr) => {
      const prevFrameRate = _manifest.geometry.targets[prev].frameRate
      const currFrameRate = _manifest.geometry.targets[curr].frameRate
      return prevFrameRate < currFrameRate ? prev : curr
    })

    const textureTypes: TextureType[] = []
    Object.keys(_manifest.texture).forEach((textureType) => {
      if (textureType !== 'path') textureTypes.push(textureType as TextureType)
    })

    const textureTargets: Partial<Record<TextureType, string[]>> = {}
    textureTypes.forEach((textureType) => {
      textureTargets[textureType] = Object.keys(_manifest.texture[textureType as TextureType].targets)
    })

    /**
     * For now choose the target with lowest frameRate
     * TODO: Adaptive target selection
     */
    const currentTextureTarget: Partial<Record<TextureType, string>> = {}

    Object.keys(textureTargets).forEach((textureType) => {
      const currentTarget = textureTargets[textureType as TextureType].reduce((prev, curr) => {
        const prevFormat = _manifest.texture[textureType as TextureType].targets[prev].format
        const currFormat = _manifest.texture[textureType as TextureType].targets[curr].format

        const isPrevSupported = isTextureFormatSupported(this.renderer, prevFormat)
        const isCurrSupported = isTextureFormatSupported(this.renderer, currFormat)

        if (!isPrevSupported && !isCurrSupported) {
          return prev // although not useful
        } else if (isPrevSupported && !isCurrSupported) {
          return prev
        } else if (!isPrevSupported && isCurrSupported) {
          return curr
        }

        const prevResolution = _manifest.texture[textureType as TextureType].targets[prev].settings.resolution
        const currResolution = _manifest.texture[textureType as TextureType].targets[prev].settings.resolution

        if (prevResolution !== undefined && currResolution !== undefined) {
          const prevPixels = prevResolution.width * prevResolution.height
          const currPixels = currResolution.width * currResolution.height
          if (prevPixels < currPixels) {
            return prev
          } else if (currPixels < prevPixels) {
            return curr
          }
        }

        const prevFrameRate = _manifest.texture[textureType as TextureType].targets[prev].frameRate
        const currFrameRate = _manifest.texture[textureType as TextureType].targets[curr].frameRate

        if (prevFrameRate < currFrameRate) {
          return prev
        } else if (prevFrameRate > currFrameRate) {
          return curr
        }

        const prevPriority = TEXTURE_FORMAT_PRIORITY[prevFormat]
        const currPriority = TEXTURE_FORMAT_PRIORITY[currFormat]

        if (prevPriority >= currPriority) {
          return prev
        } else if (currPriority > prevPriority) {
          return curr
        }
      })
      currentTextureTarget[textureType as TextureType] = currentTarget
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
      intervalId: -1 // Set this below
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

  /**
   * Fetches buffers according to Leaky Bucket algorithm.
   * If meshMap has less than required meshes, we keep fetching meshes. Otherwise, we keep fetching meshes.
   * Same goes for textures.
   */
  fetchBuffers = (callback?: fetchBuffersCallback) => {
    const promises = []

    const gTarget = this.trackData.currentGeometryTarget
    const currentGFrame = this.currentGeometryFrame()
    const gFramesPerSecond =
      this.trackData.manifest.geometry.targets[this.trackData.currentGeometryTarget].frameRate

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
          const dracoURL = this.getGeometryURL(currentRequestingFrame)
          promises.push(this.decodeDraco(dracoURL, gTarget, currentRequestingFrame))
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
            const textureURL = this.getTextureURL(currentRequestingFrame, textureType)
            promises.push(this.decodeTexture(textureURL, textureType, currentRequestingFrame))
          }
        }
      })
    }

    if (callback) {
      Promise.all(promises).then(() => {
        console.log('Initial buffers fetched. Starting playback...')
        callback()
      })
    }
  }

  decodeDraco = (dracoURL: string, target: string, frameNo: number) => {
    return new Promise((resolve, reject) => {
      this.dracoLoader.load(dracoURL, (geometry: BufferGeometry) => {
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
        this.meshMap.set([target, frameNo], geometry)
        resolve(true)
      })
    })
  }

  decodeTexture = (textureURL: string, textureType: TextureType, frameNo: number) => {
    const target = this.trackData.currentTextureTarget[textureType]
    const format = this.trackData.manifest.texture[textureType].targets[target].format

    if (format == 'ktx2') {
      return this.decodeKTX2(textureURL, textureType, frameNo)
    } else if (format == 'astc/ktx') {
      return this.decodeASTC(textureURL, textureType, frameNo)
    }
  }

  decodeASTC = (textureURL: string, textureType: TextureType, frameNo: number) => {
    const target = this.trackData.currentTextureTarget[textureType]
    const tag = this.trackData.currentTextureTag[textureType]
    const blockSize = (this.trackData.manifest.texture[textureType].targets[target] as ASTCTextureTarget)
      .settings.blocksize
    const format = ASTC_BLOCK_SIZE_TO_FORMAT[blockSize]

    return new Promise((resolve, reject) => {
      this.ktxLoader.load(textureURL, (texture: any) => {
        texture.format = format
        texture.colorSpace = SRGBColorSpace
        texture.needsUpdate = true
        this.textureMap.set([textureType, tag, target, frameNo], texture)
        resolve(true)
      })
    })
  }

  decodeKTX2 = (textureURL: string, textureType: TextureType, frameNo: number) => {
    const target = this.trackData.currentTextureTarget[textureType]
    const tag = this.trackData.currentTextureTag[textureType]

    return new Promise((resolve, reject) => {
      this.ktx2Loader.load(textureURL, (texture: CompressedTexture) => {
        texture.colorSpace = SRGBColorSpace
        texture.needsUpdate = true
        this.textureMap.set([textureType, tag, target, frameNo], texture)
        resolve(true)
      })
    })
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

  processFrame = () => {
    if (this.paused) {
      this.onMeshBuffering?.(0)
      return
    }

    if (this.trackData.hasAudio && this.audio.ended) {
      clearInterval(this.trackData.intervalId)
      this.dispose()
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

    this.removePlayedGeometryBuffer(this.trackData.currentGeometryTarget, currentGeometryFrame - 1)
    this.removePlayedTextureBuffer('baseColor', textureTag, textureTarget, currentTextureFrame - 1)

    if (currentGeometryFrame >= this.GeometryFrameCount() - 1) {
      clearInterval(this.trackData.intervalId)
      this.dispose()
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
      this.mesh.geometry = this.meshMap.get([this.trackData.currentGeometryTarget, currentGeometryFrame])
      this.mesh.geometry.attributes.position.needsUpdate = true

      this.mesh.material = this.failMaterial
      this.mesh.material.needsUpdate = true
      this.onFrameShow?.(currentGeometryFrame)
      return
    } else {
      this.mesh.geometry = this.meshMap.get([this.trackData.currentGeometryTarget, currentGeometryFrame])
      this.mesh.geometry.attributes.position.needsUpdate = true

      // @ts-ignore
      this.mesh.material.color = new Color(0xffffff)

      // @ts-ignore
      this.mesh.material.map = this.textureMap.get(['baseColor', textureTag, textureTarget, currentTextureFrame])

      // @ts-ignore
      this.mesh.material.map.needsUpdate = true

      // @ts-ignore
      this.mesh.material.needsUpdate = true

      this.onFrameShow?.(currentGeometryFrame)
    }
  }

  update = () => {
    if (!this.trackData) {
      return
    }
    this.processFrame()
  }

  removePlayedGeometryBuffer = (target: string, frameNo: number) => {
    if (this.meshMap.has([target, frameNo])) {
      const buffer = this.meshMap.get([target, frameNo])
      buffer.dispose()
      this.meshMap.delete([target, frameNo])
    }
  }

  removePlayedTextureBuffer = (textureType: TextureType, tag: string, target: string, frameNo: number) => {
    if (this.textureMap.has([textureType, tag, target, frameNo])) {
      const buffer = this.textureMap.get([textureType, tag, target, frameNo])
      buffer.dispose()
      this.textureMap.delete([textureType, tag, target, frameNo])
    }
  }

  dispose(): void {
    for (const [[gTarget, frameNo], buffer] of this.meshMap.entries()) {
      this.meshMap.delete([gTarget, frameNo])
      if (buffer && buffer instanceof BufferGeometry) {
        buffer.dispose()
      }
    }
    this.meshMap.clear()

    for (const [[textureType, tag, target, frameNo], buffer] of this.textureMap.entries()) {
      this.textureMap.delete([textureType, tag, target, frameNo])
      if (buffer && buffer.isTexture) {
        buffer.dispose()
      }
    }
    this.textureMap.clear()
  }
}
