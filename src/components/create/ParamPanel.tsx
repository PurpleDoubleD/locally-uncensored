import { useState, useEffect } from 'react'
import { useCreateStore } from '../../stores/createStore'
import { SliderControl } from '../settings/SliderControl'
import { WorkflowFinder } from './WorkflowFinder'
import { Dice5, Info, AlertTriangle, Film, ImageIcon, ImagePlus } from 'lucide-react'
import type { ClassifiedModel, ModelType } from '../../api/comfyui'
import { snapToVideoGrid, isI2VModel } from '../../api/comfyui'

interface Props {
  imageModels: ClassifiedModel[]
  videoModels: ClassifiedModel[]
  samplerList: string[]
  schedulerList: string[]
  modelsLoaded: boolean
}

const IMG_SIZE_PRESETS_SD15 = [
  { label: '512', w: 512, h: 512 },
  { label: '512x768', w: 512, h: 768 },
  { label: '768x512', w: 768, h: 512 },
  { label: '768', w: 768, h: 768 },
]

const IMG_SIZE_PRESETS_XL = [
  { label: '1024', w: 1024, h: 1024 },
  { label: '768x1344', w: 768, h: 1344 },
  { label: '1344x768', w: 1344, h: 768 },
  { label: '896x1152', w: 896, h: 1152 },
]

function getImageSizePresets(modelType: ModelType) {
  if (modelType === 'sd15') return IMG_SIZE_PRESETS_SD15
  return IMG_SIZE_PRESETS_XL
}

const VID_SIZE_PRESETS = [
  { label: '480p', w: 848, h: 480 },
  { label: '640x480', w: 640, h: 480 },
  { label: '512', w: 512, h: 512 },
  { label: '480x848', w: 480, h: 848 },
]

const TYPE_BADGE: Record<ModelType, { label: string; color: string }> = {
  flux: { label: 'FLUX', color: 'bg-purple-500/15 text-purple-300' },
  flux2: { label: 'FLUX 2', color: 'bg-purple-500/15 text-purple-300' },
  zimage: { label: 'Z-Image', color: 'bg-rose-500/15 text-rose-300' },
  sdxl: { label: 'SDXL', color: 'bg-blue-500/15 text-blue-300' },
  sd15: { label: 'SD 1.5', color: 'bg-green-500/15 text-green-300' },
  wan: { label: 'Wan', color: 'bg-orange-500/15 text-orange-300' },
  hunyuan: { label: 'Hunyuan', color: 'bg-red-500/15 text-red-300' },
  ltx: { label: 'LTX', color: 'bg-cyan-500/15 text-cyan-300' },
  mochi: { label: 'Mochi', color: 'bg-pink-500/15 text-pink-300' },
  cosmos: { label: 'Cosmos', color: 'bg-emerald-500/15 text-emerald-300' },
  cogvideo: { label: 'CogVideo', color: 'bg-amber-500/15 text-amber-300' },
  svd: { label: 'SVD', color: 'bg-indigo-500/15 text-indigo-300' },
  framepack: { label: 'FramePack', color: 'bg-teal-500/15 text-teal-300' },
  pyramidflow: { label: 'PyramidFlow', color: 'bg-violet-500/15 text-violet-300' },
  allegro: { label: 'Allegro', color: 'bg-rose-500/15 text-rose-300' },
  unknown: { label: 'Model', color: 'bg-white/10 text-gray-400' },
}

export function ParamPanel({ imageModels, videoModels, samplerList, schedulerList, modelsLoaded }: Props) {
  const store = useCreateStore()
  const isVideo = store.mode === 'video'
  const isI2I = store.mode === 'image' && store.imageSubMode === 'img2img'
  const [videoSubTab, setVideoSubTab] = useState<'t2v' | 'i2v'>('t2v')
  const sizePresets = isVideo ? VID_SIZE_PRESETS : getImageSizePresets(store.imageModelType)

  // Filter video models by sub-tab
  const filteredVideoModels = isVideo
    ? videoModels.filter(m => videoSubTab === 'i2v' ? isI2VModel(m.name) : !isI2VModel(m.name))
    : videoModels
  const models = isVideo ? filteredVideoModels : imageModels  // i2i also uses imageModels

  // Auto-select first model in filtered list when switching video sub-tabs
  useEffect(() => {
    if (!isVideo || filteredVideoModels.length === 0) return
    const currentModel = store.videoModel
    const isCurrentInList = filteredVideoModels.some(m => m.name === currentModel)
    if (!isCurrentInList) {
      store.setVideoModel(filteredVideoModels[0].name)
    }
  }, [videoSubTab, isVideo])

  const sel = 'w-full px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/8 text-gray-900 dark:text-white text-[11px] focus:outline-none focus:border-gray-400 dark:focus:border-white/20 cursor-pointer'
  const lbl = 'text-[10px] font-medium text-gray-500 dark:text-gray-600 uppercase tracking-widest mb-1 block'

  const handleModelChange = (name: string) => {
    if (isVideo) {
      store.setVideoModel(name)
    } else {
      const model = imageModels.find(m => m.name === name)
      store.setImageModel(name, model?.type ?? 'unknown')
    }
  }

  const activeModel = isVideo ? store.videoModel : store.imageModel
  const videoDuration = isVideo ? (store.frames / store.fps).toFixed(1) : null

  return (
    <div className="space-y-3">
      {/* Video Sub-Tabs: Text to Video / Image to Video */}
      {isVideo && (
        <div className="flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5 gap-0.5">
          <button
            onClick={() => setVideoSubTab('t2v')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-medium transition-all ${
              videoSubTab === 't2v'
                ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <Film size={11} />
            Text to Video
          </button>
          <button
            onClick={() => setVideoSubTab('i2v')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-medium transition-all ${
              videoSubTab === 'i2v'
                ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <ImageIcon size={11} />
            Image to Video
          </button>
        </div>
      )}

      {/* Image Sub-Tabs: Text to Image / Image to Image */}
      {!isVideo && (
        <div className="flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5 gap-0.5">
          <button
            onClick={() => store.setImageSubMode('text2img')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-medium transition-all ${
              store.imageSubMode === 'text2img'
                ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <ImageIcon size={11} />
            Text to Image
          </button>
          <button
            onClick={() => store.setImageSubMode('img2img')}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[10px] font-medium transition-all ${
              store.imageSubMode === 'img2img'
                ? 'bg-white dark:bg-white/15 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            <ImagePlus size={11} />
            Image to Image
          </button>
        </div>
      )}

      {/* Model */}
      <div>
        <label className={lbl}>{isVideo ? (videoSubTab === 'i2v' ? 'I2V Model' : 'Video Model') : 'Image Model'}</label>
        {!modelsLoaded ? (
          <div className="px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/8 text-gray-400 dark:text-gray-600 text-[10px] animate-pulse">
            Loading...
          </div>
        ) : models.length === 0 ? (
          <div className="px-2.5 py-1.5 rounded-lg bg-yellow-500/5 border border-yellow-500/10 text-yellow-400 text-[10px]">
            No models found
          </div>
        ) : (
          <>
            <select value={activeModel} onChange={(e) => handleModelChange(e.target.value)} className={sel}>
              {models.map((m) => {
                const badge = TYPE_BADGE[m.type]
                const shortName = m.name.replace(/\.[^.]+$/, '')
                return <option key={m.name} value={m.name}>{shortName} ({badge.label})</option>
              })}
            </select>
            {activeModel && (() => {
              const model = models.find(m => m.name === activeModel)
              if (!model) return null
              const badge = TYPE_BADGE[model.type]
              return (
                <span className={`mt-1 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium ${badge.color}`}>
                  {badge.label}
                </span>
              )
            })()}
          </>
        )}
      </div>

      {/* Sampler + Scheduler side by side */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={lbl}>Sampler</label>
          <select value={store.sampler} onChange={(e) => store.setSampler(e.target.value)} className={sel}>
            {samplerList.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>Scheduler</label>
          <select value={store.scheduler} onChange={(e) => store.setScheduler(e.target.value)} className={sel}>
            {schedulerList.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {/* Steps + CFG side by side */}
      <div className="grid grid-cols-2 gap-2">
        <SliderControl label="Steps" value={store.steps} min={1} max={50} step={1} onChange={store.setSteps} />
        <SliderControl label="CFG" value={store.cfgScale} min={0} max={30} step={0.5} onChange={store.setCfgScale} />
      </div>

      {/* Batch Size (not for I2I) */}
      {!isVideo && !isI2I && (
        <SliderControl label="Batch" value={store.batchSize} min={1} max={4} step={1} onChange={store.setBatchSize} />
      )}

      {/* Denoise Strength (I2I only) */}
      {isI2I && (
        <SliderControl label="Denoise" value={store.denoise} min={0.05} max={1.0} step={0.05} onChange={store.setDenoise} />
      )}

      {/* Size */}
      <div>
        <label className={lbl}>Size ({store.width}x{store.height})</label>
        <div className="flex flex-wrap gap-1">
          {sizePresets.map((preset) => (
            <button
              key={preset.label}
              onClick={() => store.setSize(preset.w, preset.h)}
              className={`px-1.5 py-0.5 rounded text-[10px] transition-all ${
                store.width === preset.w && store.height === preset.h
                  ? 'bg-gray-800 dark:bg-white/15 text-white'
                  : 'bg-gray-100 dark:bg-white/5 text-gray-500 hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Seed */}
      <div>
        <label className={lbl}>Seed</label>
        <div className="flex gap-1.5">
          <input
            type="number"
            value={store.seed}
            onChange={(e) => store.setSeed(parseInt(e.target.value) || -1)}
            className="flex-1 px-2.5 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/8 text-gray-900 dark:text-white text-[11px] focus:outline-none font-mono"
            placeholder="-1"
          />
          <button
            onClick={() => store.setSeed(-1)}
            className="p-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/8 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors"
            title="Random"
            aria-label="Random seed"
          >
            <Dice5 size={12} />
          </button>
        </div>
      </div>

      {/* Video params */}
      {isVideo && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <SliderControl label="Frames" value={store.frames} min={1} max={81} step={4} onChange={store.setFrames} />
            <SliderControl label="FPS" value={store.fps} min={4} max={30} step={1} onChange={store.setFps} />
          </div>
          <div className="flex items-center gap-1 text-[10px] text-gray-500">
            <Info size={10} />
            ~{videoDuration}s ({store.frames}f @ {store.fps}fps)
          </div>
          {(store.width % 16 !== 0 || store.height % 16 !== 0) && (
            <button
              onClick={() => { const s = snapToVideoGrid(store.width, store.height); store.setSize(s.width, s.height) }}
              className="flex items-center gap-1 text-[10px] text-yellow-400 hover:underline"
              aria-label="Fix video dimensions"
            >
              <AlertTriangle size={10} /> Fix to {snapToVideoGrid(store.width, store.height).width}x{snapToVideoGrid(store.width, store.height).height}
            </button>
          )}
          {store.frames > 40 && (
            <div className="flex items-center gap-1 text-[10px] text-orange-400">
              <AlertTriangle size={10} /> High VRAM usage
            </div>
          )}
        </>
      )}

      {/* Workflow (bottom) */}
      <div className="pt-2 border-t border-gray-200 dark:border-white/5">
        <WorkflowFinder
          modelName={activeModel}
          modelType={isVideo ? (models.find(m => m.name === activeModel)?.type ?? 'unknown') : store.imageModelType}
        />
      </div>
    </div>
  )
}
