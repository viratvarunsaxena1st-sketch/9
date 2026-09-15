<script>
  import { settings } from '../stores/settingsStore'
  import { constantChange } from '../stores/constantChangeStore'
  import {
    CATALOG,
    TIER_CYCLE,
    buildVariants,
    describePermutation,
    detectPlateau,
    blockPeakNLevel,
    validateSelection,
  } from './constantChange.js'
  import { Info } from '@lucide/svelte'

  let openSection = null
  let warning = null

  const toggleSection = (name) => {
    openSection = openSection === name ? null : name
  }

  const familyLabels = {
    position: 'Grid',
    audio: 'Audio',
    color: 'Colour',
    shape: 'Shape',
    image: 'Image',
  }

  const tierLabels = { dual: 'Dual', tri: 'Tri', quad: 'Quad' }

  const isOn = (state, family, id) => {
    const list = state.enabled?.[family]
    return list == null ? true : list.includes(id)
  }

  const toggle = (family, id) => {
    const result = constantChange.toggleOption(family, id)
    warning = result && !result.ok ? result.errors[0] : null
  }

  const changeNow = async () => {
    warning = null
    await constantChange.changeNow()
  }

  const reroll = () => {
    warning = null
    constantChange.rerollVariant()
  }

  $: state = $constantChange
  $: block = state.current
  $: variant = block?.variant
  $: verdict = block ? detectPlateau(block.days ?? [], state.config) : null
  $: selection = validateSelection(CATALOG, state.enabled, state.blocked)
  $: variantPoolSize = block ? buildVariants(block.permutation, CATALOG).length : 0
  $: peak = block ? blockPeakNLevel(block) : null
  $: days = block?.days ?? []
</script>

<div class="flex flex-col gap-2">

  <!-- what you are training right now -->
  {#if block}
  <div class="rounded border border-base-content/20 p-3 flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <span class="badge badge-sm">{tierLabels[block.tier]} n-back</span>
      <span class="text-xs opacity-70">
        {days.length} training {days.length === 1 ? 'day' : 'days'} logged
      </span>
    </div>

    <div class="text-base leading-snug">{describePermutation(block.permutation, CATALOG)}</div>

    <div class="text-xs opacity-70 flex flex-wrap gap-x-3 gap-y-1">
      <span>N-back {$settings.gameSettings.constant?.nBack ?? '-'}</span>
      {#if peak != null}<span>peak n{peak}</span>{/if}
      <span>{variantPoolSize} day-variants</span>
    </div>

    {#if variant}
    <div class="divider my-0"></div>
    <div class="text-xs opacity-70">Today's draw</div>
    <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
      <span>Trials</span><span class="text-right">{variant.numTrials}</span>
      <span>Interference</span><span class="text-right">{variant.interference}%</span>
      <span>Feedback</span><span class="text-right">{variant.feedback === 'show' ? 'Shown' : 'Hidden'}</span>
      {#if variant.rotationSpeed !== null}
        <span>Rotation</span>
        <span class="text-right">{variant.rotationSpeed === 0 ? 'Still' : variant.rotationSpeed}</span>
      {/if}
    </div>
    {/if}

    {#if verdict}
    <div class="divider my-0"></div>
    <div class="text-xs {verdict.plateau ? 'text-amber-500' : 'opacity-70'}">
      {verdict.plateau ? 'Plateau reached — changing after this session.' : verdict.reason}
    </div>
    {/if}

    <div class="flex gap-2 pt-1">
      <button class="btn btn-xs flex-1" on:click={reroll}>New day draw</button>
      <button class="btn btn-xs flex-1" on:click={changeNow}>Change now</button>
    </div>
  </div>
  {:else}
  <div class="rounded border border-base-content/20 p-3 text-sm opacity-70">
    Starting your first permutation. Press play to begin.
  </div>
  {/if}

  {#if warning}
  <div class="alert alert-warning text-xs p-2">{warning}</div>
  {/if}

  <!-- rotation -->
  <button class="btn btn-sm btn-ghost justify-between" on:click={() => toggleSection('rotation')}>
    <span>Permutations in rotation</span>
    <span class="text-xs opacity-70">{selection.total}</span>
  </button>

  {#if openSection === 'rotation'}
  <div class="rounded border border-base-content/20 p-3 flex flex-col gap-3">
    <p class="text-xs opacity-70">
      Turn options off to keep them out of rotation. Leaving only a few on is how you
      restrict training to a specific set. Each tier draws every one of its combinations
      before any of them repeat.
    </p>

    <div class="flex gap-3 text-xs">
      {#each TIER_CYCLE as tier (tier)}
        <span class="opacity-70">{tierLabels[tier]} <b>{selection.counts[tier]}</b></span>
      {/each}
    </div>

    {#each Object.keys(familyLabels) as family (family)}
      <div class="flex flex-col gap-1">
        <div class="text-sm">{familyLabels[family]}</div>
        <div class="flex flex-wrap gap-1">
          {#each CATALOG[family] as option (option.id)}
            <button
              class="btn btn-xs {isOn(state, family, option.id) ? 'btn-primary' : 'btn-outline opacity-50'}"
              on:click={() => toggle(family, option.id)}
            >{option.label}</button>
          {/each}
        </div>
      </div>
    {/each}

    <div class="alert text-xs p-2 flex gap-2 items-start">
      <Info size="14" />
      <span>
        Quad pairs colour with shape only. An image stimulus is drawn over the whole cell,
        so it would hide any colour or shape running beside it.
      </span>
    </div>
  </div>
  {/if}

  <!-- rules -->
  <button class="btn btn-sm btn-ghost justify-between" on:click={() => toggleSection('rules')}>
    <span>When to change</span>
    <span class="text-xs opacity-70">{state.config.plateauWindow} days</span>
  </button>

  {#if openSection === 'rules'}
  <div class="rounded border border-base-content/20 p-3 flex flex-col gap-3">
    <p class="text-xs opacity-70">
      The permutation changes once your n-level has been flat for this many training days
      and the last of them failed to beat the first by the threshold.
    </p>

    <div class="flex flex-col gap-1">
      <label class="text-sm" for="cc-window">Flat days before a change: {state.config.plateauWindow}</label>
      <input id="cc-window" type="range" min="2" max="8" class="range range-sm"
        value={state.config.plateauWindow}
        on:input={(e) => constantChange.setConfig('plateauWindow', +e.target.value)} />
    </div>

    <div class="grid grid-cols-[4fr_6fr] items-center gap-3">
      <span class="text-sm">Improvement</span>
      <select class="select select-sm" value={state.config.improvementMode}
        on:change={(e) => constantChange.setConfig('improvementMode', e.target.value)}>
        <option value="relative">Relative (x1.15)</option>
        <option value="absolute">Absolute (+15 pts)</option>
      </select>
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm" for="cc-threshold">Threshold: {state.config.improvementThreshold}{state.config.improvementMode === 'relative' ? '%' : ' pts'}</label>
      <input id="cc-threshold" type="range" min="0" max="40" class="range range-sm"
        value={state.config.improvementThreshold}
        on:input={(e) => constantChange.setConfig('improvementThreshold', +e.target.value)} />
    </div>

    <div class="grid grid-cols-[7fr_3fr] items-center gap-3">
      <span class="text-sm">Quad to dual n-level</span>
      <select class="select select-sm" value={state.config.literalQuadToDualHalving ? 'half' : 'double'}
        on:change={(e) => constantChange.setConfig('literalQuadToDualHalving', e.target.value === 'half')}>
        <option value="double">x2</option>
        <option value="half">/2</option>
      </select>
    </div>

    <div class="grid grid-cols-[7fr_3fr] items-center gap-3">
      <span class="text-sm">Day draw applies to</span>
      <select class="select select-sm" value={state.config.variantScope}
        on:change={(e) => constantChange.setConfig('variantScope', e.target.value)}>
        <option value="day">Whole day</option>
        <option value="session">Each game</option>
      </select>
    </div>

    <p class="text-xs opacity-60">
      Threshold moves block length very little — once n stops climbing you rarely clear the
      bar anyway. The flat-days slider is the one that matters.
    </p>
  </div>
  {/if}

  <!-- history -->
  <button class="btn btn-sm btn-ghost justify-between" on:click={() => toggleSection('history')}>
    <span>Past permutations</span>
    <span class="text-xs opacity-70">{state.history.length}</span>
  </button>

  {#if openSection === 'history'}
  <div class="rounded border border-base-content/20 p-3 flex flex-col gap-2 max-h-64 overflow-y-auto">
    {#if state.history.length === 0}
      <p class="text-xs opacity-70">Nothing yet. Your first change will show up here.</p>
    {:else}
      {#each state.history as entry, i (entry.endedAt + '-' + i)}
        <div class="text-xs flex flex-col gap-0.5 border-b border-base-content/10 pb-2">
          <div class="flex justify-between gap-2">
            <span class="badge badge-xs">{tierLabels[entry.tier]}</span>
            <span class="opacity-70">{entry.days} days &middot; peak n{entry.peakNLevel}</span>
          </div>
          <div>{entry.label}</div>
          <div class="opacity-60">
            {entry.reason} &rarr; {tierLabels[entry.toTier]} at n{entry.carried}
          </div>
        </div>
      {/each}
    {/if}
    <button class="btn btn-xs btn-outline mt-1" on:click={() => constantChange.resetPools()}>
      Clear used-permutation pools
    </button>
  </div>
  {/if}

</div>
