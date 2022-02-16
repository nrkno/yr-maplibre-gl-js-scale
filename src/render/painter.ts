import browser from '../util/browser';
import {mat4, vec3} from 'gl-matrix';
import SourceCache from '../source/source_cache';
import EXTENT from '../data/extent';
import pixelsToTileUnits from '../source/pixels_to_tile_units';
import SegmentVector from '../data/segment';
import {RasterBoundsArray, PosArray, TriangleIndexArray, LineStripIndexArray} from '../data/array_types.g';
import rasterBoundsAttributes from '../data/raster_bounds_attributes';
import posAttributes from '../data/pos_attributes';
import ProgramConfiguration from '../data/program_configuration';
import CrossTileSymbolIndex from '../symbol/cross_tile_symbol_index';
import shaders from '../shaders/shaders';
import Program from './program';
import {programUniforms} from './program/program_uniforms';
import Context from '../gl/context';
import DepthMode from '../gl/depth_mode';
import StencilMode from '../gl/stencil_mode';
import ColorMode from '../gl/color_mode';
import CullFaceMode from '../gl/cull_face_mode';
import Texture from './texture';
import {clippingMaskUniformValues} from './program/clipping_mask_program';
import Color from '../style-spec/util/color';
import symbol from './draw_symbol';
import circle from './draw_circle';
import heatmap from './draw_heatmap';
import line from './draw_line';
import fill from './draw_fill';
import fillExtrusion from './draw_fill_extrusion';
import hillshade from './draw_hillshade';
import raster from './draw_raster';
import background from './draw_background';
import debug, {drawDebugPadding} from './draw_debug';
import custom from './draw_custom';
import {prepareTerrain, drawTerrain, updateTerrainFacilitators} from './draw_terrain';
import {OverscaledTileID} from '../source/tile_id';

const draw = {
    symbol,
    circle,
    heatmap,
    line,
    fill,
    'fill-extrusion': fillExtrusion,
    hillshade,
    raster,
    background,
    debug,
    custom
};

import type Transform from '../geo/transform';
import type Tile from '../source/tile';
import type Style from '../style/style';
import type StyleLayer from '../style/style_layer';
import type {CrossFaded} from '../style/properties';
import type LineAtlas from './line_atlas';
import type ImageManager from './image_manager';
import type GlyphManager from './glyph_manager';
import type VertexBuffer from '../gl/vertex_buffer';
import type IndexBuffer from '../gl/index_buffer';
import type {DepthRangeType, DepthMaskType, DepthFuncType} from '../gl/types';
import type ResolvedImage from '../style-spec/expression/types/resolved_image';
import type {RGBAImage} from '../util/image';

export type RenderPass = 'offscreen' | 'opaque' | 'translucent';

type PainterOptions = {
    showOverdrawInspector: boolean;
    showTileBoundaries: boolean;
    showPadding: boolean;
    rotating: boolean;
    zooming: boolean;
    moving: boolean;
    gpuTiming: boolean;
    fadeDuration: number;
};

/**
 * Initialize a new painter object.
 *
 * @param {Canvas} gl an experimental-webgl drawing context
 * @private
 */
class Painter {
    context: Context;
    transform: Transform;
    _tileTextures: {
        [_: number]: Array<Texture>;
    };
    numSublayers: number;
    depthEpsilon: number;
    emptyProgramConfiguration: ProgramConfiguration;
    width: number;
    height: number;
    pixelRatio: number;
    tileExtentBuffer: VertexBuffer;
    tileExtentSegments: SegmentVector;
    debugBuffer: VertexBuffer;
    debugSegments: SegmentVector;
    rasterBoundsBuffer: VertexBuffer;
    rasterBoundsSegments: SegmentVector;
    viewportBuffer: VertexBuffer;
    viewportSegments: SegmentVector;
    quadTriangleIndexBuffer: IndexBuffer;
    tileBorderIndexBuffer: IndexBuffer;
    _tileClippingMaskIDs: {[_: string]: number};
    stencilClearMode: StencilMode;
    style: Style;
    options: PainterOptions;
    lineAtlas: LineAtlas;
    imageManager: ImageManager;
    glyphManager: GlyphManager;
    depthRangeFor3D: DepthRangeType;
    opaquePassCutoff: number;
    renderPass: RenderPass;
    currentLayer: number;
    currentStencilSource: string;
    nextStencilID: number;
    id: string;
    _showOverdrawInspector: boolean;
    cache: {[_: string]: Program<any>};
    crossTileSymbolIndex: CrossTileSymbolIndex;
    symbolFadeChange: number;
    gpuTimers: {[_: string]: any};
    emptyTexture: Texture;
    debugOverlayTexture: Texture;
    debugOverlayCanvas: HTMLCanvasElement;
    // this object stores the current camera-matrix and the last render time
    // of the terrain-facilitators. e.g. depth & coords framebuffers
    // every time the camera-matrix changes the terrain-facilitators will be redrawn.
    terrainFacilitator: {matrix: mat4; renderTime: number};

    constructor(gl: WebGLRenderingContext, transform: Transform) {
        this.context = new Context(gl);
        this.transform = transform;
        this._tileTextures = {};
        this.terrainFacilitator = {matrix: mat4.create(), renderTime: 0};

        this.setup();

        // Within each layer there are multiple distinct z-planes that can be drawn to.
        // This is implemented using the WebGL depth buffer.
        this.numSublayers = SourceCache.maxUnderzooming + SourceCache.maxOverzooming + 1;
        this.depthEpsilon = 1 / Math.pow(2, 16);

        this.crossTileSymbolIndex = new CrossTileSymbolIndex();

        this.gpuTimers = {};
    }

    /*
     * Update the GL viewport, projection matrix, and transforms to compensate
     * for a new width and height value.
     */
    resize(width: number, height: number, pixelRatio: number) {
        this.width = width * pixelRatio;
        this.height = height * pixelRatio;
        this.pixelRatio = pixelRatio;
        this.context.viewport.set([0, 0, this.width, this.height]);

        if (this.style) {
            for (const layerId of this.style._order) {
                this.style._layers[layerId].resize();
            }
        }
    }

    setup() {
        const context = this.context;

        const tileExtentArray = new PosArray();
        tileExtentArray.emplaceBack(0, 0);
        tileExtentArray.emplaceBack(EXTENT, 0);
        tileExtentArray.emplaceBack(0, EXTENT);
        tileExtentArray.emplaceBack(EXTENT, EXTENT);
        this.tileExtentBuffer = context.createVertexBuffer(tileExtentArray, posAttributes.members);
        this.tileExtentSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const debugArray = new PosArray();
        debugArray.emplaceBack(0, 0);
        debugArray.emplaceBack(EXTENT, 0);
        debugArray.emplaceBack(0, EXTENT);
        debugArray.emplaceBack(EXTENT, EXTENT);
        this.debugBuffer = context.createVertexBuffer(debugArray, posAttributes.members);
        this.debugSegments = SegmentVector.simpleSegment(0, 0, 4, 5);

        const rasterBoundsArray = new RasterBoundsArray();
        rasterBoundsArray.emplaceBack(0, 0, 0, 0);
        rasterBoundsArray.emplaceBack(EXTENT, 0, EXTENT, 0);
        rasterBoundsArray.emplaceBack(0, EXTENT, 0, EXTENT);
        rasterBoundsArray.emplaceBack(EXTENT, EXTENT, EXTENT, EXTENT);
        this.rasterBoundsBuffer = context.createVertexBuffer(rasterBoundsArray, rasterBoundsAttributes.members);
        this.rasterBoundsSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const viewportArray = new PosArray();
        viewportArray.emplaceBack(0, 0);
        viewportArray.emplaceBack(1, 0);
        viewportArray.emplaceBack(0, 1);
        viewportArray.emplaceBack(1, 1);
        this.viewportBuffer = context.createVertexBuffer(viewportArray, posAttributes.members);
        this.viewportSegments = SegmentVector.simpleSegment(0, 0, 4, 2);

        const tileLineStripIndices = new LineStripIndexArray();
        tileLineStripIndices.emplaceBack(0);
        tileLineStripIndices.emplaceBack(1);
        tileLineStripIndices.emplaceBack(3);
        tileLineStripIndices.emplaceBack(2);
        tileLineStripIndices.emplaceBack(0);
        this.tileBorderIndexBuffer = context.createIndexBuffer(tileLineStripIndices);

        const quadTriangleIndices = new TriangleIndexArray();
        quadTriangleIndices.emplaceBack(0, 1, 2);
        quadTriangleIndices.emplaceBack(2, 1, 3);
        this.quadTriangleIndexBuffer = context.createIndexBuffer(quadTriangleIndices);

        this.emptyTexture = new Texture(context, {
            width: 1,
            height: 1,
            data: new Uint8Array([0, 0, 0, 0])
        } as RGBAImage, context.gl.RGBA);

        const gl = this.context.gl;
        this.stencilClearMode = new StencilMode({func: gl.ALWAYS, mask: 0}, 0x0, 0xFF, gl.ZERO, gl.ZERO, gl.ZERO);
    }

    /*
     * Reset the drawing canvas by clearing the stencil buffer so that we can draw
     * new tiles at the same location, while retaining previously drawn pixels.
     */
    clearStencil() {
        const context = this.context;
        const gl = context.gl;

        this.nextStencilID = 1;
        this.currentStencilSource = undefined;

        // As a temporary workaround for https://github.com/mapbox/mapbox-gl-js/issues/5490,
        // pending an upstream fix, we draw a fullscreen stencil=0 clipping mask here,
        // effectively clearing the stencil buffer: once an upstream patch lands, remove
        // this function in favor of context.clear({ stencil: 0x0 })

        const matrix = mat4.create();
        mat4.ortho(matrix, 0, this.width, this.height, 0, 0, 1);
        mat4.scale(matrix, matrix, [gl.drawingBufferWidth, gl.drawingBufferHeight, 0]);

        this.useProgram('clippingMask').draw(context, gl.TRIANGLES,
            DepthMode.disabled, this.stencilClearMode, ColorMode.disabled, CullFaceMode.disabled,
            clippingMaskUniformValues(matrix), null,
            '$clipping', this.viewportBuffer,
            this.quadTriangleIndexBuffer, this.viewportSegments);
    }

    _renderTileClippingMasks(layer: StyleLayer, tileIDs: Array<OverscaledTileID>) {
        if (this.currentStencilSource === layer.source || !layer.isTileClipped() || !tileIDs || !tileIDs.length) return;

        this.currentStencilSource = layer.source;

        const context = this.context;
        const gl = context.gl;

        if (this.nextStencilID + tileIDs.length > 256) {
            // we'll run out of fresh IDs so we need to clear and start from scratch
            this.clearStencil();
        }

        context.setColorMode(ColorMode.disabled);
        context.setDepthMode(DepthMode.disabled);

        const program = this.useProgram('clippingMask');

        this._tileClippingMaskIDs = {};

        for (const tileID of tileIDs) {
            const id = this._tileClippingMaskIDs[tileID.key] = this.nextStencilID++;
            const terrain = this.style.terrainSourceCache.getTerrain(tileID);

            program.draw(context, gl.TRIANGLES, DepthMode.disabled,
                // Tests will always pass, and ref value will be written to stencil buffer.
                new StencilMode({func: gl.ALWAYS, mask: 0}, id, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE),
                ColorMode.disabled, CullFaceMode.disabled, clippingMaskUniformValues(tileID.posMatrix),
                terrain, '$clipping', this.tileExtentBuffer,
                this.quadTriangleIndexBuffer, this.tileExtentSegments);
        }
    }

    stencilModeFor3D(): StencilMode {
        this.currentStencilSource = undefined;

        if (this.nextStencilID + 1 > 256) {
            this.clearStencil();
        }

        const id = this.nextStencilID++;
        const gl = this.context.gl;
        return new StencilMode({func: gl.NOTEQUAL, mask: 0xFF}, id, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
    }

    stencilModeForClipping(tileID: OverscaledTileID): StencilMode {
        const gl = this.context.gl;
        return new StencilMode({func: gl.EQUAL, mask: 0xFF}, this._tileClippingMaskIDs[tileID.key], 0x00, gl.KEEP, gl.KEEP, gl.REPLACE);
    }

    /*
     * Sort coordinates by Z as drawing tiles is done in Z-descending order.
     * All children with the same Z write the same stencil value.  Children
     * stencil values are greater than parent's.  This is used only for raster
     * and raster-dem tiles, which are already clipped to tile boundaries, to
     * mask area of tile overlapped by children tiles.
     * Stencil ref values continue range used in _tileClippingMaskIDs.
     *
     * Returns [StencilMode for tile overscaleZ map, sortedCoords].
     */
    stencilConfigForOverlap(tileIDs: Array<OverscaledTileID>): [{
        [_: number]: Readonly<StencilMode>;
    }, Array<OverscaledTileID>] {
        const gl = this.context.gl;
        const coords = tileIDs.sort((a, b) => b.overscaledZ - a.overscaledZ);
        const minTileZ = coords[coords.length - 1].overscaledZ;
        const stencilValues = coords[0].overscaledZ - minTileZ + 1;
        if (stencilValues > 1) {
            this.currentStencilSource = undefined;
            if (this.nextStencilID + stencilValues > 256) {
                this.clearStencil();
            }
            const zToStencilMode = {};
            for (let i = 0; i < stencilValues; i++) {
                zToStencilMode[i + minTileZ] = new StencilMode({func: gl.GEQUAL, mask: 0xFF}, i + this.nextStencilID, 0xFF, gl.KEEP, gl.KEEP, gl.REPLACE);
            }
            this.nextStencilID += stencilValues;
            return [zToStencilMode, coords];
        }
        return [{[minTileZ]: StencilMode.disabled}, coords];
    }

    colorModeForRenderPass(): Readonly<ColorMode> {
        const gl = this.context.gl;
        if (this._showOverdrawInspector) {
            const numOverdrawSteps = 8;
            const a = 1 / numOverdrawSteps;

            return new ColorMode([gl.CONSTANT_COLOR, gl.ONE], new Color(a, a, a, 0), [true, true, true, true]);
        } else if (this.renderPass === 'opaque') {
            return ColorMode.unblended;
        } else {
            return ColorMode.alphaBlended;
        }
    }

    depthModeForSublayer(n: number, mask: DepthMaskType, func?: DepthFuncType | null): Readonly<DepthMode> {
        if (!this.opaquePassEnabledForLayer()) return DepthMode.disabled;
        const depth = 1 - ((1 + this.currentLayer) * this.numSublayers + n) * this.depthEpsilon;
        return new DepthMode(func || this.context.gl.LEQUAL, mask, [depth, depth]);
    }

    /*
     * The opaque pass and 3D layers both use the depth buffer.
     * Layers drawn above 3D layers need to be drawn using the
     * painter's algorithm so that they appear above 3D features.
     * This returns true for layers that can be drawn using the
     * opaque pass.
     */
    opaquePassEnabledForLayer() {
        return this.currentLayer < this.opaquePassCutoff;
    }

    render(style: Style, options: PainterOptions) {
        this.style = style;
        this.options = options;

        this.lineAtlas = style.lineAtlas;
        this.imageManager = style.imageManager;
        this.glyphManager = style.glyphManager;

        this.symbolFadeChange = style.placement.symbolFadeChange(browser.now());

        this.imageManager.beginFrame();

        const layerIds = this.style._order;
        const sourceCaches = this.style.sourceCaches;
        const renderToTexture = {background: true, fill: true, line: true, raster: true};
        const tsc = this.style.terrainSourceCache;
        const isTerrainEnabled = tsc.isEnabled();

        for (const id in sourceCaches) {
            const sourceCache = sourceCaches[id];
            if (sourceCache.used) {
                sourceCache.prepare(this.context);
            }
        }

        const coordsAscending: {[_: string]: Array<OverscaledTileID>} = {};
        const coordsDescending: {[_: string]: Array<OverscaledTileID>} = {};
        const coordsDescendingSymbol: {[_: string]: Array<OverscaledTileID>} = {};
        // this is used for 3d-terrain
        // coordsDescendingInv contains a list of all tiles which should be rendered for one render-to-texture tile
        // e.g. render 4 raster-tiles with size 256px to the 512px render-to-texture tile
        const coordsDescendingInv: {[_: string]: {[_:string]: Array<OverscaledTileID>}} = {};
        const coordsDescendingInvStr: {[_: string]: {[_:string]: string}} = {};

        for (const id in sourceCaches) {
            const sourceCache = sourceCaches[id];
            coordsAscending[id] = sourceCache.getVisibleCoordinates();
            coordsDescending[id] = coordsAscending[id].slice().reverse();
            coordsDescendingSymbol[id] = sourceCache.getVisibleCoordinates(true).reverse();
            if (isTerrainEnabled) {
                coordsDescendingInv[id] = {};
                for (let c = 0; c < coordsDescending[id].length; c++) {
                    const coords = tsc.getTerrainCoords(coordsDescending[id][c]);
                    for (const key in coords) {
                        if (!coordsDescendingInv[id][key]) coordsDescendingInv[id][key] = [];
                        coordsDescendingInv[id][key].push(coords[key]);
                    }
                }
            }
        }

        // create a string representation of all to tiles rendered to render-to-texture tiles
        // this string representation is used to check if tile should be re-rendered.
        for (const id of layerIds) {
            const layer = this.style._layers[id], source = layer.source;
            if (renderToTexture[layer.type]) {
                if (!coordsDescendingInvStr[source]) {
                    coordsDescendingInvStr[source] = {};
                    for (const key in coordsDescendingInv[source])
                        coordsDescendingInvStr[source][key] = coordsDescendingInv[source][key].map(c => c.key).sort().join();
                }
            }
        }

        this.opaquePassCutoff = Infinity;
        for (let i = 0; i < layerIds.length; i++) {
            const layerId = layerIds[i];
            if (this.style._layers[layerId].is3D()) {
                this.opaquePassCutoff = i;
                break;
            }
        }

        if (isTerrainEnabled) {
            // this is disabled, because render-to-texture is rendering all layers from bottom to top.
            this.opaquePassCutoff = 0;

            // update coords/depth-framebuffer on camera movement, ore tile reloading
            const newTiles = tsc.tilesAfterTime(this.terrainFacilitator.renderTime);
            if (!mat4.equals(this.terrainFacilitator.matrix, this.transform.projMatrix) || newTiles.length) {
                mat4.copy(this.terrainFacilitator.matrix, this.transform.projMatrix);
                this.terrainFacilitator.renderTime = Date.now();
                updateTerrainFacilitators(this, tsc);
            }
        }

        // Offscreen pass ===============================================
        // We first do all rendering that requires rendering to a separate
        // framebuffer, and then save those for rendering back to the map
        // later: in doing this we avoid doing expensive framebuffer restores.
        this.renderPass = 'offscreen';

        for (const layerId of layerIds) {
            const layer = this.style._layers[layerId];
            if (!layer.hasOffscreenPass() || layer.isHidden(this.transform.zoom)) continue;

            const coords = coordsDescending[layer.source];
            if (layer.type !== 'custom' && !coords.length) continue;

            this.renderLayer(this, sourceCaches[layer.source], layer, coords);
        }

        // Rebind the main framebuffer now that all offscreen layers have been rendered:
        this.context.bindFramebuffer.set(null);

        // Clear buffers in preparation for drawing to the main framebuffer
        this.context.clear({color: options.showOverdrawInspector ? Color.black : Color.transparent, depth: 1});
        this.clearStencil();

        this._showOverdrawInspector = options.showOverdrawInspector;
        this.depthRangeFor3D = [0, 1 - ((style._order.length + 2) * this.numSublayers * this.depthEpsilon)];

        // Opaque pass ===============================================
        // Draw opaque layers top-to-bottom first.
        if (!isTerrainEnabled) {
            this.renderPass = 'opaque';

            for (this.currentLayer = layerIds.length - 1; this.currentLayer >= 0; this.currentLayer--) {
                const layer = this.style._layers[layerIds[this.currentLayer]];
                const sourceCache = sourceCaches[layer.source];
                const coords = coordsAscending[layer.source];

                this._renderTileClippingMasks(layer, coords);
                this.renderLayer(this, sourceCache, layer, coords);
            }
        }

        // Translucent pass ===============================================
        // Draw all other layers bottom-to-top.
        this.renderPass = 'translucent';

        // the following variables only used when terrain-3d is enabled
        const stacks = []; // render layers not one by one, instead group into stacks
        let prevType = null; // remember the type of the last layer when render to a stack
        const rerender = {}; // create a lookup which tiles should rendered to texture
        let renderableTiles = []; // all terrain-tiles for the current scene
        if (isTerrainEnabled) {
            renderableTiles = tsc.getRenderableTiles();
            renderableTiles.forEach(tile => {
                for (const source in coordsDescendingInvStr) {
                    // rerender if there are more coords to render than in the last rendering
                    const coords = coordsDescendingInvStr[source][tile.tileID.key];
                    if (coords && coords !== tile.textureCoords[source]) tile.clearTextures(this);
                    // rerender if terrainSourceCache has marked tile for rerender
                    if (tsc.rerender[source] && tsc.rerender[source][tile.tileID.key]) tile.clearTextures(this);
                }
                // rerender if there are no previous renderings
                rerender[tile.tileID.key] = !tile.textures.length;
            });
            // reset terrainSource rerender cache
            tsc.rerender = {};
        }

        for (this.currentLayer = 0; this.currentLayer < layerIds.length; this.currentLayer++) {
            const layer = this.style._layers[layerIds[this.currentLayer]];
            const sourceCache = sourceCaches[layer.source];
            const type = layer.type;

            if (isTerrainEnabled) {
                // due that switching textures is relatively slow, the render
                // layer-by-layer context here is not practicable. To bypass this problem
                // this lines of code stack all layers and later render all at once.
                // Because of the stylesheet possibility to mixing render-to-texture layers
                // and 'live'-layers (f.e. symbols) it is necessary to create more stacks. For example
                // a symbol-layer is in between of fill-layers.

                const isLastLayer = this.currentLayer + 1 === layerIds.length;

                // remember background, fill, line & raster layer to render into a stack
                if (renderToTexture[type]) {
                    if (!prevType || !renderToTexture[prevType]) stacks.push([]);
                    prevType = type;
                    stacks[stacks.length - 1].push(layerIds[this.currentLayer]);
                    // rendering is done later, all in once
                    if (!isLastLayer) continue;
                }

                // in case a stack is finished render all collected stack-layers into a texture
                if (renderToTexture[prevType] || type === 'hillshade' || (renderToTexture[type] && isLastLayer)) {
                    prevType = type;
                    const stack = stacks.length - 1, layers = stacks[stack] || [];
                    for (const tile of renderableTiles) {
                        prepareTerrain(this, tsc, tile, stack);
                        if (rerender[tile.tileID.key]) {
                            this.context.clear({color: Color.transparent});
                            for (let l = 0; l < layers.length; l++) {
                                const layer = this.style._layers[layers[l]];
                                const coords = layer.source ? coordsDescendingInv[layer.source][tile.tileID.key] : [tile.tileID];
                                this._renderTileClippingMasks(layer, coords);
                                this.renderLayer(this, this.style.sourceCaches[layer.source], layer, coords);
                                if (layer.source) tile.textureCoords[layer.source] = coordsDescendingInvStr[layer.source][tile.tileID.key];
                            }
                        }
                        drawTerrain(this, tsc, tile);
                    }

                    // the hillshading layer is a special case because it changes on every camera-movement
                    // so rerender it in any case.
                    // FIX ME-3D! check if rerendering is really necessary, depending on hillshade-illumination-anchor
                    if (type === 'hillshade') {
                        stacks.push([layerIds[this.currentLayer]]);
                        for (const tile of renderableTiles) {
                            const coords = coordsDescendingInv[layer.source][tile.tileID.key];
                            // FIX ME-3D! replace prepareTerrain with hillshading texture from prepareHillshading directly
                            prepareTerrain(this, tsc, tile, stacks.length - 1);
                            this.context.clear({color: Color.transparent});
                            this._renderTileClippingMasks(layer, coords);
                            this.renderLayer(this, sourceCache, layer, coords);
                            drawTerrain(this, tsc, tile);
                        }
                        continue;
                    }
                }

            }

            // For symbol layers in the translucent pass, we add extra tiles to the renderable set
            // for cross-tile symbol fading. Symbol layers don't use tile clipping, so no need to render
            // separate clipping masks
            const coords = (layer.type === 'symbol' ? coordsDescendingSymbol : coordsDescending)[layer.source];

            this._renderTileClippingMasks(layer, coordsAscending[layer.source]);
            this.renderLayer(this, sourceCache, layer, coords);
        }

        if (this.options.showTileBoundaries) {
            //Use source with highest maxzoom
            let selectedSource;
            let sourceCache;
            const layers = Object.values(this.style._layers);
            layers.forEach((layer) => {
                if (layer.source && !layer.isHidden(this.transform.zoom)) {
                    if (layer.source !== (sourceCache && sourceCache.id)) {
                        sourceCache = this.style.sourceCaches[layer.source];
                    }
                    if (!selectedSource || (selectedSource.getSource().maxzoom < sourceCache.getSource().maxzoom)) {
                        selectedSource = sourceCache;
                    }
                }
            });
            if (selectedSource) {
                draw.debug(this, selectedSource, selectedSource.getVisibleCoordinates());
            }
        }

        if (this.options.showPadding) {
            drawDebugPadding(this);
        }

        // Set defaults for most GL values so that anyone using the state after the render
        // encounters more expected values.
        this.context.setDefault();
    }

    renderLayer(painter: Painter, sourceCache: SourceCache, layer: StyleLayer, coords: Array<OverscaledTileID>) {
        if (layer.isHidden(this.transform.zoom)) return;
        if (layer.type !== 'background' && layer.type !== 'custom' && !(coords || []).length) return;
        this.id = layer.id;

        this.gpuTimingStart(layer);
        draw[layer.type](painter, sourceCache, layer as any, coords, this.style.placement.variableOffsets);
        this.gpuTimingEnd();
    }

    gpuTimingStart(layer: StyleLayer) {
        if (!this.options.gpuTiming) return;
        const ext = this.context.extTimerQuery;
        // This tries to time the draw call itself, but note that the cost for drawing a layer
        // may be dominated by the cost of uploading vertices to the GPU.
        // To instrument that, we'd need to pass the layerTimers object down into the bucket
        // uploading logic.
        let layerTimer = this.gpuTimers[layer.id];
        if (!layerTimer) {
            layerTimer = this.gpuTimers[layer.id] = {
                calls: 0,
                cpuTime: 0,
                query: ext.createQueryEXT()
            };
        }
        layerTimer.calls++;
        ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, layerTimer.query);
    }

    gpuTimingEnd() {
        if (!this.options.gpuTiming) return;
        const ext = this.context.extTimerQuery;
        ext.endQueryEXT(ext.TIME_ELAPSED_EXT);
    }

    collectGpuTimers() {
        const currentLayerTimers = this.gpuTimers;
        this.gpuTimers = {};
        return currentLayerTimers;
    }

    queryGpuTimers(gpuTimers: {[_: string]: any}) {
        const layers = {};
        for (const layerId in gpuTimers) {
            const gpuTimer = gpuTimers[layerId];
            const ext = this.context.extTimerQuery;
            const gpuTime = ext.getQueryObjectEXT(gpuTimer.query, ext.QUERY_RESULT_EXT) / (1000 * 1000);
            ext.deleteQueryEXT(gpuTimer.query);
            layers[layerId] = gpuTime;
        }
        return layers;
    }

    /**
     * Transform a matrix to incorporate the *-translate and *-translate-anchor properties into it.
     * @param inViewportPixelUnitsUnits True when the units accepted by the matrix are in viewport pixels instead of tile units.
     * @returns {mat4} matrix
     * @private
     */
    translatePosMatrix(matrix: mat4, tile: Tile, translate: [number, number], translateAnchor: 'map' | 'viewport', inViewportPixelUnitsUnits?: boolean) {
        if (!translate[0] && !translate[1]) return matrix;

        const angle = inViewportPixelUnitsUnits ?
            (translateAnchor === 'map' ? this.transform.angle : 0) :
            (translateAnchor === 'viewport' ? -this.transform.angle : 0);

        if (angle) {
            const sinA = Math.sin(angle);
            const cosA = Math.cos(angle);
            translate = [
                translate[0] * cosA - translate[1] * sinA,
                translate[0] * sinA + translate[1] * cosA
            ];
        }

        const translation = vec3.fromValues(
            inViewportPixelUnitsUnits ? translate[0] : pixelsToTileUnits(tile, translate[0], this.transform.zoom),
            inViewportPixelUnitsUnits ? translate[1] : pixelsToTileUnits(tile, translate[1], this.transform.zoom),
            0
        );

        const translatedMatrix = new Float32Array(16);
        mat4.translate(translatedMatrix, matrix, translation);
        return translatedMatrix;
    }

    saveTileTexture(texture: Texture) {
        const textures = this._tileTextures[texture.size[0]];
        if (!textures) {
            this._tileTextures[texture.size[0]] = [texture];
        } else {
            textures.push(texture);
        }
    }

    getTileTexture(size: number) {
        const textures = this._tileTextures[size];
        return textures && textures.length > 0 ? textures.pop() : null;
    }

    /**
     * Checks whether a pattern image is needed, and if it is, whether it is not loaded.
     *
     * @returns true if a needed image is missing and rendering needs to be skipped.
     * @private
     */
    isPatternMissing(image?: CrossFaded<ResolvedImage> | null): boolean {
        if (!image) return false;
        if (!image.from || !image.to) return true;
        const imagePosA = this.imageManager.getPattern(image.from.toString());
        const imagePosB = this.imageManager.getPattern(image.to.toString());
        return !imagePosA || !imagePosB;
    }

    useProgram(name: string, programConfiguration?: ProgramConfiguration | null): Program<any> {
        this.cache = this.cache || {};
        const key = name +
            (programConfiguration ? programConfiguration.cacheKey : '') +
            (this._showOverdrawInspector ? '/overdraw' : '') +
            (this.style.terrainSourceCache.isEnabled() ? '/terrain' : '');
        if (!this.cache[key]) {
            this.cache[key] = new Program(
                this.context,
                name,
                shaders[name],
                programConfiguration,
                programUniforms[name],
                this._showOverdrawInspector,
                this.style.terrainSourceCache.isEnabled()
            );
        }
        return this.cache[key];
    }

    /*
     * Reset some GL state to default values to avoid hard-to-debug bugs
     * in custom layers.
     */
    setCustomLayerDefaults() {
        // Prevent custom layers from unintentionally modify the last VAO used.
        // All other state is state is restored on it's own, but for VAOs it's
        // simpler to unbind so that we don't have to track the state of VAOs.
        this.context.unbindVAO();

        // The default values for this state is meaningful and often expected.
        // Leaving this state dirty could cause a lot of confusion for users.
        this.context.cullFace.setDefault();
        this.context.activeTexture.setDefault();
        this.context.pixelStoreUnpack.setDefault();
        this.context.pixelStoreUnpackPremultiplyAlpha.setDefault();
        this.context.pixelStoreUnpackFlipY.setDefault();
    }

    /*
     * Set GL state that is shared by all layers.
     */
    setBaseState() {
        const gl = this.context.gl;
        this.context.cullFace.set(false);
        this.context.viewport.set([0, 0, this.width, this.height]);
        this.context.blendEquation.set(gl.FUNC_ADD);
    }

    initDebugOverlayCanvas() {
        if (this.debugOverlayCanvas == null) {
            this.debugOverlayCanvas = document.createElement('canvas');
            this.debugOverlayCanvas.width = 512;
            this.debugOverlayCanvas.height = 512;
            const gl = this.context.gl;
            this.debugOverlayTexture = new Texture(this.context, this.debugOverlayCanvas, gl.RGBA);
        }
    }

    destroy() {
        this.emptyTexture.destroy();
        if (this.debugOverlayTexture) {
            this.debugOverlayTexture.destroy();
        }
    }
}

export default Painter;
