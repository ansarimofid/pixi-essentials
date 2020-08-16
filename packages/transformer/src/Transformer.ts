/// <reference path="./types.d.ts" />

import { Renderer } from '@pixi/core';
import { DisplayObject, Container } from '@pixi/display';
import { Point, Matrix, Transform, Rectangle } from '@pixi/math';
import { Graphics } from '@pixi/graphics';
import { AxisAlignedBounds, OrientedBounds } from '@pixi-essentials/bounds';
import { ObjectPoolFactory } from '@pixi-essentials/object-pool';
import { TransformerHandle } from './TransformerHandle';
import { createHorizontalSkew, createVerticalSkew } from './utils/skewTransform';
import { decomposeTransform } from './utils/decomposeTransform';
import { multiplyTransform } from './utils/multiplyTransform';

import type { InteractionEvent } from '@pixi/interaction';
import type { ITransformerHandleStyle } from './TransformerHandle';

// Preallocated objects
const tempTransform = new Transform();
const tempCorners: [Point, Point, Point, Point] = [new Point(), new Point(), new Point(), new Point()];
const tempMatrix = new Matrix();
const tempPoint = new Point();
const tempBounds = new OrientedBounds();
const tempRect = new Rectangle();

// Pool for allocating an arbitrary number of points
const pointPool = ObjectPoolFactory.build(Point as any);

/**
 * The handles used for rotation.
 *
 * @internal
 * @ignore
 */
type RotateHandle = 'rotator';

/**
 * The handles used for scaling.
 *
 * @internal
 * @ignore
 */
type ScaleHandle = 'topLeft' |
    'topCenter' |
    'topRight' |
    'middleLeft' |
    'middleCenter' |
    'middleRight' |
    'bottomLeft' |
    'bottomCenter' |
    'bottomRight';

/**
 * The handles used for skewing
 *
 * @internal
 * @ignore
 */
type SkewHandle = 'skewHorizontal' | 'skewVertical';

/**
 * All the handles provided by {@link Transformer}.
 *
 * @internal
 * @ignore
 */
export type Handle = RotateHandle | ScaleHandle | SkewHandle;

/**
 * Specific cursors for each handle
 *
 * @internal
 * @ignore
 */
const HANDLE_TO_CURSOR: { [H in Handle]?: string } = {
    topLeft: 'nw-resize',
    topCenter: 'n-resize',
    topRight: 'ne-resize',
    middleLeft: 'w-resize',
    middleRight: 'e-resize',
    bottomLeft: 'sw-resize',
    bottomCenter: 's-resize',
    bottomRight: 'se-resize',
};

/**
 * An array of all {@link ScaleHandle} values.
 *
 * @internal
 * @ignore
 */
const SCALE_HANDLES: ScaleHandle[] = [
    'topLeft',
    'topCenter',
    'topRight',
    'middleLeft',
    'middleCenter',
    'middleRight',
    'bottomLeft',
    'bottomCenter',
    'bottomRight',
];

/**
 * This maps each scaling handle to the directions in which the x, y components are outward. A value of
 * zero means that no scaling occurs along that component's axis.
 *
 * @internal
 * @ignore
 */
const SCALE_COMPONENTS: {
    [H in ScaleHandle]: { x: (-1 | 0 | 1); y: (-1 | 0 | 1) };
 } = {
     topLeft: { x: -1, y: -1 },
     topCenter: { x: 0, y: -1 },
     topRight: { x: 1, y: -1 },
     middleLeft: { x: -1, y: 0 },
     middleCenter: { x: 0, y: 0 },
     middleRight: { x: 1, y: 0 },
     bottomLeft: { x: -1, y: 1 },
     bottomCenter: { x: 0, y: 1 },
     bottomRight: { x: 1, y: 1 },
 };

/**
 * All possible values of {@link Handle}.
 *
 * @ignore
 */
const HANDLES = [
    ...SCALE_HANDLES,
    'rotator',
    'skewHorizontal',
    'skewVertical',
];

/**
 * The default snap angles for rotation, in radians.
 *
 * @ignore
 */
const DEFAULT_ROTATION_SNAPS = [
    Math.PI / 4,
    Math.PI / 2,
    Math.PI * 3 / 4,
    Math.PI,
    -Math.PI / 4,
    -Math.PI / 2,
    -Math.PI * 3 / 4,
    -Math.PI,
];

/**
 * The default snap tolerance, i.e. the maximum angle b/w the pointer & nearest snap ray for snapping.
 *
 * @ignore
 */
const DEFAULT_ROTATION_SNAP_TOLERANCE = Math.PI / 90;

/**
 * The default snap angles for skewing, in radians.
 *
 * @ignore
 */
const DEFAULT_SKEW_SNAPS = [
    Math.PI / 4,
    -Math.PI / 4,
];

/**
 * The default snap tolerance for skewing.
 *
 * @ignore
 */
const DEFAULT_SKEW_SNAP_TOLERANCE = Math.PI / 90;

/**
 * @ignore
 */
export interface ITransformerStyle
{
    color: number;
    thickness: number;
}

/**
 * The default wireframe style for {@link Transformer}.
 *
 * @ignore
 */
const DEFAULT_WIREFRAME_STYLE: ITransformerStyle = {
    color: 0x000000,
    thickness: 2,
};

/**
 * @ignore
 */
export interface ITransformerOptions
{
    centeredScaling: boolean;
    enabledHandles?: Array<Handle>;
    group: DisplayObject[];
    handleConstructor: typeof DisplayObject;
    handleStyle: Partial<ITransformerHandleStyle>;
    rotateEnabled?: boolean;
    rotationSnaps?: number[];
    rotationSnapTolerance?: number;
    scaleEnabled?: boolean;
    skewEnabled?: boolean;
    skewRadius?: number;
    skewSnaps?: number[];
    skewSnapTolerance?: number;
    translateEnabled?: boolean;
    transientGroupTilt?: boolean;
    wireframeStyle: Partial<ITransformerStyle>;
}

/**
 * {@code Transformer} provides an interactive interface for editing the transforms in a group. It supports translating,
 * scaling, rotating, and skewing display-objects both through interaction and code.
 *
 * NOTE: The transformer needs to capture all interaction events that would otherwise go to the display-objects in the
 * group. Hence, it must be placed after them in the scene graph.
 */
export class Transformer extends Container
{
    public group: DisplayObject[];

    public centeredScaling: boolean;
    public rotationSnaps: number[];
    public rotationSnapTolerance: number;
    public skewRadius: number;
    public skewSnaps: number[];
    public skewSnapTolerance: number;
    public translateEnabled: boolean;
    public transientGroupTilt: boolean;

    protected groupBounds: OrientedBounds;
    protected handles: { [H in Handle]: TransformerHandle };
    protected wireframe: Graphics;

    protected _enabledHandles: Handle[];
    protected _rotateEnabled: boolean;
    protected _scaleEnabled: boolean;
    protected _skewEnabled: boolean;
    protected _skewX: number;
    protected _skewY: number;
    protected _handleStyle: Partial<ITransformerHandleStyle>;
    protected _wireframeStyle: Partial<ITransformerStyle>;

    private _pointerDown: boolean;
    private _pointerDragging: boolean;
    private _pointerPosition: Point;

    /* eslint-disable max-len */
    /**
     * | Handle                | Type                     | Notes |
     * | --------------------- | ------------------------ | ----- |
     * | rotator               | Rotate                   | |
     * | topLeft               | Scale                    | |
     * | topCenter             | Scale                    | |
     * | topRight              | Scale                    | |
     * | middleLeft            | Scale                    | |
     * | middleCenter          | Scale                    | This cannot be enabled!                                             |
     * | middleRight           | Scale                    | |
     * | bottomLeft            | Scale                    | |
     * | bottomCenter          | Scale                    | |
     * | bottomRight           | Scale                    | |
     * | skewHorizontal        | Skew                     | Applies vertical shear. Handle segment is horizontal at skew.y = 0! |
     * | skewVertical          | Skew                     | Applied horizontal shear. Handle segment is vertical at skew.x = 0! |
     *
     * @param {object}[options]
     * @param {DisplayObject[]}[options.group] - the group of display-objects being transformed
     * @param {boolean}[options.enabledHandles] - specifically define which handles are to be enabled
     * @param {typeof TransformerHandle}[options.handleConstructor] - a custom transformer-handle class
     * @param {object}[options.handleStyle] - styling options for the handle. These cannot be modified afterwards!
     * @param {number}[options.handleStyle.color] - handle color
     * @param {string}[options.handleStyle.outlineColor] - color of the handle outline (stroke)
     * @param {string}[options.handleStyle.outlineThickness] - thickness of the handle outline (stroke)
     * @param {number}[options.handleStyle.radius] - dimensions of the handle
     * @param {string}[options.handleStyle.shape] - 'circle' or 'square'
     * @param {boolean}[options.rotateEnabled=true] - whether rotate handles are enabled
     * @param {number[]}[options.rotationSnaps] - the rotation snap angles, in radians. By default, transformer will
     *      snap for each 1/8th of a revolution.
     * @param {number}[options.rotationSnapTolerance] - the snap tolerance for rotation in radians
     * @param {boolean}[options.scaleEnabled=true] - whether scale handles are enabled
     * @param {boolean}[options.skewEnabled=true] - whether skew handles are enabled
     * @param {number}[options.skewRadius] - distance of skew handles from center of transformer box
     *      (`skewTransform` should be enabled)
     * @param {number[]}[options.skewSnaps] - the skew snap angles, in radians.
     * @param {number}[options.skewSnapTolerance] - the skew snap tolerance angle.
     * @param {boolean}[options.translateEnabled=true] - whether dragging the transformer should move the group
     * @param {boolean}[options.transientGroupTilt=true] - whether the transformer should reset the wireframe's rotation
     *      after a rotator handle is "defocused".
     * @param {object}[options.wireframeStyle] - styling options for the wireframe.
     * @param {number}[options.wireframeStyle.color] - color of the lines
     * @param {number}[options.wireframeStyle.thickness] - thickness of the lines
     */
    constructor(options: Partial<ITransformerOptions> = {})
    {
    /* eslint-enable max-len */
        super();

        this.interactive = true;
        this.cursor = 'move';

        this.group = options.group || [];
        this.centeredScaling = !!options.centeredScaling;
        this.rotationSnaps = options.rotationSnaps || DEFAULT_ROTATION_SNAPS;
        this.rotationSnapTolerance = options.rotationSnapTolerance !== undefined
            ? options.rotationSnapTolerance
            : DEFAULT_ROTATION_SNAP_TOLERANCE;
        this.skewRadius = options.skewRadius || 64;
        this.skewSnaps = options.skewSnaps || DEFAULT_SKEW_SNAPS;
        this.skewSnapTolerance = options.skewSnapTolerance !== undefined
            ? options.skewSnapTolerance
            : DEFAULT_SKEW_SNAP_TOLERANCE;
        this._rotateEnabled = options.rotateEnabled !== false;
        this._scaleEnabled = options.scaleEnabled !== false;
        this._skewEnabled = options.skewEnabled === true;
        this.translateEnabled = options.translateEnabled !== false;
        this.transientGroupTilt = options.transientGroupTilt !== undefined ? options.transientGroupTilt : true;

        /**
         * Draws the bounding boxes
         */
        this.wireframe = this.addChild(new Graphics());

        /**
         * The horizontal skew value. Rotating the group by 𝜽 will also change this value by 𝜽.
         */
        this._skewX = 0;

        /**
         * The vertical skew value. Rotating the group by 𝜽 will also change this value by 𝜽.
         */
        this._skewY = 0;

        /**
         * The wireframe style applied on the transformer
         */
        this._wireframeStyle = Object.assign({}, DEFAULT_WIREFRAME_STYLE, options.wireframeStyle || {});

        const HandleConstructor = options.handleConstructor || TransformerHandle;
        const handleStyle = options.handleStyle || {};

        this._handleStyle = handleStyle;

        // Initialize transformer handles
        const rotatorHandles = {
            rotator: this.addChild(
                new HandleConstructor(
                    'rotator',
                    handleStyle,
                    (pointerPosition) =>
                    {
                        // The origin is the rotator handle's position, yes.
                        this.rotateGroup('rotator', pointerPosition);
                    },
                    this.commitGroup,
                )),
        };
        const scaleHandles = SCALE_HANDLES.reduce((scaleHandles, handleKey: ScaleHandle) =>
        {
            const handleDelta = (pointerPosition: Point): void =>
            {
                this.scaleGroup(handleKey as ScaleHandle, pointerPosition);
            };

            scaleHandles[handleKey] = new HandleConstructor(
                handleKey,
                handleStyle,
                handleDelta,
                this.commitGroup,
                HANDLE_TO_CURSOR[handleKey]);
            scaleHandles[handleKey].visible = this._scaleEnabled;
            this.addChild(scaleHandles[handleKey]);

            return scaleHandles;
        }, {});
        const skewHandles = {
            skewHorizontal: this.addChild(
                new HandleConstructor(
                    'skewHorizontal',
                    handleStyle,
                    (pointerPosition: Point) => { this.skewGroup('skewHorizontal', pointerPosition); },
                    this.commitGroup,
                    'pointer',
                )),
            skewVertical: this.addChild(
                new HandleConstructor(
                    'skewVertical',
                    handleStyle,
                    (pointerPosition: Point) => { this.skewGroup('skewVertical', pointerPosition); },
                    this.commitGroup,
                    'pointer',
                )),
        };

        this.handles = Object.assign({}, rotatorHandles, scaleHandles, skewHandles) as { [H in Handle]: TransformerHandle };
        this.handles.middleCenter.visible = false;
        this.handles.skewHorizontal.visible = this._skewEnabled;
        this.handles.skewVertical.visible = this._skewEnabled;

        // Update groupBounds immediately. This is because mouse events can propagate before the next animation frame.
        this.groupBounds = new OrientedBounds();
        this.updateGroupBounds();

        // Pointer events
        this._pointerDown = false;
        this._pointerDragging = false;
        this._pointerPosition = new Point();
        this.on('pointerdown', this.onPointerDown, this);
        this.on('pointermove', this.onPointerMove, this);
        this.on('pointerup', this.onPointerUp, this);
        this.on('pointerupoutside', this.onPointerUp, this);
    }

    /**
     * The list of enabled handles, if applied manually.
     */
    get enabledHandles(): Array<Handle>
    {
        return this._enabledHandles;
    }
    set enabledHandles(value: Array<Handle>)
    {
        if (!this._enabledHandles && !value)
        {
            return;
        }

        this._enabledHandles = value;

        HANDLES.forEach((handleKey) => { this.handles[handleKey].visible = false; });

        if (value)
        {
            value.forEach((handleKey) => { this.handles[handleKey].visible = true; });
        }
        else
        {
            this.handles.rotator.visible = this._rotateEnabled;
            this.handles.skewHorizontal.visible = this._skewEnabled;
            this.handles.skewVertical.visible = this._skewEnabled;

            SCALE_HANDLES.forEach((handleKey) =>
            {
                if (handleKey === 'middleCenter') return;

                this.handles[handleKey].visible = this._scaleEnabled;
            });
        }
    }

    /**
     * The currently applied handle style. If you have edited the transformer handles directly, this may be inaccurate.
     */
    get handleStyle(): Partial<ITransformerHandleStyle>
    {
        return this._handleStyle;
    }
    set handleStyle(value: Partial<ITransformerHandleStyle>)
    {
        const handles = this.handles;

        for (const handleKey in handles)
        {
            (handles[handleKey] as TransformerHandle).style = value;
        }

        this._handleStyle = value;
    }

    /**
     * This will enable the rotate handles.
     */
    get rotateEnabled(): boolean
    {
        return this._rotateEnabled;
    }
    set rotateEnabled(value: boolean)
    {
        if (!this._rotateEnabled !== value)
        {
            this._rotateEnabled = value;

            if (this._enabledHandles)
            {
                return;
            }

            this.handles.rotator.visible = value;
        }
    }

    /**
     * This will enable the scale handles.
     */
    get scaleEnabled(): boolean
    {
        return this._scaleEnabled;
    }
    set scaleEnabled(value: boolean)
    {
        if (!this._scaleEnabled !== value)
        {
            this._scaleEnabled = value;

            if (this._enabledHandles)
            {
                return;
            }

            SCALE_HANDLES.forEach((handleKey) =>
            {
                if (handleKey === 'middleCenter')
                {
                    return;
                }

                this.handles[handleKey].visible = value;
            });
        }
    }

    /**
     * This will enable the skew handles.
     */
    get skewEnabled(): boolean
    {
        return this._skewEnabled;
    }
    set skewEnabled(value: boolean)
    {
        if (this._skewEnabled !== value)
        {
            this._skewEnabled = value;

            if (this._enabledHandles)
            {
                return;
            }

            this.handles.skewHorizontal.visible = value;
            this.handles.skewVertical.visible = value;
        }
    }

    /**
     * The currently applied wireframe style.
     */
    get wireframeStyle(): Partial<ITransformerStyle>
    {
        return this._wireframeStyle;
    }
    set wireframeStyle(value: Partial<ITransformerStyle>)
    {
        this._wireframeStyle = Object.assign({}, DEFAULT_WIREFRAME_STYLE, value);
    }

    /**
     * This will translate the group by {@code delta}.
     *
     * NOTE: There is no handle that provides translation. The user drags the transformer directly.
     *
     * @param delta
     */
    translateGroup = (delta: Point): void =>
    {
        // Translation matrix
        const matrix = tempMatrix
            .identity()
            .translate(delta.x, delta.y);

        this.prependTransform(matrix);
    };

    /**
     * This will rotate the group such that the handle will come to {@code pointerPosition}.
     *
     * @param handle - the rotator handle was dragged
     * @param pointerPosition - the new pointer position (after dragging)
     */
    rotateGroup = (handle: RotateHandle, pointerPosition: Point): void =>
    {
        const bounds = this.groupBounds;
        const origin = this.handles[handle].position;
        const destination = pointerPosition;

        // Center of rotation - does not change in transformation
        const rOrigin = bounds.center;

        // Original angle subtended by pointer
        const orgAngle = Math.atan2(origin.y - rOrigin.y, origin.x - rOrigin.x);

        // Final angle subtended by pointer
        const dstAngle = Math.atan2(destination.y - rOrigin.y, destination.x - rOrigin.x);

        // The angle by which bounds should be rotated
        let deltaAngle = dstAngle - orgAngle;

        // Snap
        let newRotation = this.groupBounds.rotation + deltaAngle;

        newRotation = this.snapAngle(newRotation, this.rotationSnapTolerance, this.rotationSnaps);
        deltaAngle = newRotation - this.groupBounds.rotation;

        // Rotation matrix
        const matrix = tempMatrix
            .identity()
            .translate(-rOrigin.x, -rOrigin.y)
            .rotate(deltaAngle)
            .translate(rOrigin.x, rOrigin.y);

        this.prependTransform(matrix, true);
        this.updateGroupBounds(newRotation);

        // Rotation moves both skew.x & skew.y
        this._skewX += deltaAngle;
        this._skewY += deltaAngle;
    };

    /**
     * This will scale the group such that the scale handle will come under {@code pointerPosition}.
     *
     * @param handle - the scaling handle that was dragged
     * @param pointerPosition - the new pointer position
     */
    scaleGroup = (handle: ScaleHandle, pointerPosition: Point): void =>
    {
        // Directions along x,y axes that will produce positive scaling
        const xDir = SCALE_COMPONENTS[handle].x;
        const yDir = SCALE_COMPONENTS[handle].y;

        const bounds = this.groupBounds;
        const angle = bounds.rotation;
        const innerBounds = bounds.innerBounds;

        // Delta vector in world frame
        const dx = pointerPosition.x - this.handles[handle].x;
        const dy = pointerPosition.y - this.handles[handle].y;

        // Unit vector along u-axis (horizontal axis after rotation) of bounds
        const uxvec = (bounds.topRight.x - bounds.topLeft.x) / innerBounds.width;
        const uyvec = (bounds.topRight.y - bounds.topLeft.y) / innerBounds.width;

        // Unit vector along v-axis (vertical axis after rotation) of bounds
        const vxvec = (bounds.bottomLeft.x - bounds.topLeft.x) / innerBounds.height;
        const vyvec = (bounds.bottomLeft.y - bounds.topLeft.y) / innerBounds.height;

        // Delta vector in rotated frame of bounds
        const du = (dx * uxvec) + (dy * uyvec);
        const dv = (dx * vxvec) + (dy * vyvec);

        // Scaling factors along x,y axes
        const sx = 1 + (du * xDir / innerBounds.width);
        const sy = 1 + (dv * yDir / innerBounds.height);

        const matrix = tempMatrix.identity();

        if (xDir !== 0)
        {
            // Origin of horizontal scaling - a point which does not move after applying the transform
            // eslint-disable-next-line no-nested-ternary
            const hsOrigin = !this.centeredScaling ? (xDir === 1 ? bounds.topLeft : bounds.topRight) : bounds.center;

            matrix.translate(-hsOrigin.x, -hsOrigin.y)
                .rotate(-angle)
                .scale(sx, 1)
                .rotate(angle)
                .translate(hsOrigin.x, hsOrigin.y);
        }

        if (yDir !== 0)
        {
            // Origin of vertical scaling - a point which does not move after applying the transform
            // eslint-disable-next-line no-nested-ternary
            const vsOrigin = !this.centeredScaling ? (yDir === 1 ? bounds.topLeft : bounds.bottomLeft) : bounds.center;

            matrix.translate(-vsOrigin.x, -vsOrigin.y)
                .rotate(-angle)
                .scale(1, sy)
                .rotate(angle)
                .translate(vsOrigin.x, vsOrigin.y);
        }

        this.prependTransform(matrix);
    };

    /**
     * This will skew the group such that the skew handle would move to the {@code pointerPosition}.
     *
     * @param handle
     * @param pointerPosition
     */
    skewGroup = (handle: SkewHandle, pointerPosition: Point): void =>
    {
        const bounds = this.groupBounds;

        // Destination point
        const dst = tempPoint.copyFrom(pointerPosition);

        // Center of skew (same as center of rotation!)
        const sOrigin = bounds.center;

        // Skew matrix
        const matrix = tempMatrix.identity()
            .translate(-sOrigin.x, -sOrigin.y);
        let rotation = this.groupBounds.rotation;

        if (handle === 'skewHorizontal')
        {
            const oldSkew = this._skewX;

            // Calculate new skew
            this._skewX = Math.atan2(dst.y - sOrigin.y, dst.x - sOrigin.x);
            this._skewX = this.snapAngle(this._skewX, this.skewSnapTolerance, this.skewSnaps);

            // Skew by new skew.x
            matrix.prepend(createVerticalSkew(-oldSkew));
            matrix.prepend(createVerticalSkew(this._skewX));
        }
        else // skewVertical
        {
            const oldSkew = this._skewY;

            // Calculate new skew
            const newSkew = Math.atan2(dst.y - sOrigin.y, dst.x - sOrigin.x) - (Math.PI / 2);

            this._skewY = newSkew;
            this._skewY = this.snapAngle(this._skewY, this.skewSnapTolerance, this.skewSnaps);

            // HINT: skewY is applied negatively b/c y-axis is flipped
            matrix.prepend(createHorizontalSkew(oldSkew));
            matrix.prepend(createHorizontalSkew(-this._skewY));

            rotation -= this._skewY - oldSkew;
        }

        matrix.translate(sOrigin.x, sOrigin.y);

        this.prependTransform(matrix, true);
        this.updateGroupBounds(rotation);
    };

    /**
     * This is called after the user finishes dragging a handle. If {@link this.transientGroupTilt} is enabled, it will
     * reset the rotation of this group (if more than one display-object is grouped).
     */
    commitGroup = (): void =>
    {
        if (this.transientGroupTilt !== false && this.group.length > 1)
        {
            this.updateGroupBounds(0);
        }
    };

    /**
     * This will update the transformer's geometry and render it to the canvas.
     *
     * @override
     * @param renderer
     */
    render(renderer: Renderer): void
    {
        this.draw();

        super.render(renderer);
    }

    /**
     * Recalculates the transformer's geometry. This is called on each render.
     */
    protected draw(): void
    {
        const targets = this.group;
        const { color, thickness } = this._wireframeStyle;

        // Updates occur right here!
        this.wireframe.clear()
            .lineStyle(thickness, color);

        for (let i = 0, j = targets.length; i < j; i++)
        {
            this.drawBounds(Transformer.calculateOrientedBounds(targets[i], tempBounds));
        }

        // groupBounds may change on each render-loop b/c of any ongoing animation
        const groupBounds = targets.length !== 1
            ? Transformer.calculateGroupOrientedBounds(targets, this.groupBounds.rotation, tempBounds, true)
            : Transformer.calculateOrientedBounds(targets[0], tempBounds);// Auto-detect rotation

        // Redraw skeleton and position handles
        this.drawBounds(groupBounds);
        this.drawHandles(groupBounds);

        // Update cached groupBounds
        this.groupBounds.copyFrom(groupBounds);
    }

    /**
     * Draws the bounding box into {@code this.skeleton}.
     *
     * @param bounds
     */
    protected drawBounds(bounds: OrientedBounds | AxisAlignedBounds): void
    {
        // Fill polygon with ultra-low alpha to capture pointer events.
        this.wireframe
            .beginFill(0xffffff, 1e-4)
            .drawPolygon(bounds.hull)
            .endFill();
    }

    /**
     * Draw the handles and any remaining parts of the skeleton
     *
     * @param groupBounds
     */
    protected drawHandles(groupBounds: OrientedBounds): void
    {
        const handles = this.handles;

        const { topLeft, topRight, bottomLeft, bottomRight, center } = groupBounds;

        if (this._rotateEnabled)
        {
            groupBounds.innerBounds.pad(32);

            handles.rotator.position.x = (groupBounds.topLeft.x + groupBounds.topRight.x) / 2;
            handles.rotator.position.y = (groupBounds.topLeft.y + groupBounds.topRight.y) / 2;

            groupBounds.innerBounds.pad(-32);

            const bx = (groupBounds.topLeft.x + groupBounds.topRight.x) / 2;
            const by = (groupBounds.topLeft.y + groupBounds.topRight.y) / 2;

            this.wireframe.moveTo(bx, by)
                .lineTo(handles.rotator.position.x, handles.rotator.position.y);
        }

        if (this._scaleEnabled)
        {
            // Scale handles
            handles.topLeft.position.copyFrom(topLeft);
            handles.topCenter.position.set((topLeft.x + topRight.x) / 2, (topLeft.y + topRight.y) / 2);
            handles.topRight.position.copyFrom(topRight);
            handles.middleLeft.position.set((topLeft.x + bottomLeft.x) / 2, (topLeft.y + bottomLeft.y) / 2);
            handles.middleCenter.position.set((topLeft.x + bottomRight.x) / 2, (topLeft.y + bottomRight.y) / 2);
            handles.middleRight.position.set((topRight.x + bottomRight.x) / 2, (topRight.y + bottomRight.y) / 2);
            handles.bottomLeft.position.copyFrom(bottomLeft);
            handles.bottomCenter.position.set((bottomLeft.x + bottomRight.x) / 2, (bottomLeft.y + bottomRight.y) / 2);
            handles.bottomRight.position.copyFrom(bottomRight);
        }

        if (this._skewEnabled)
        {
            // Skew handles
            handles.skewHorizontal.position.set(
                center.x + (Math.cos(this._skewX) * this.skewRadius),
                center.y + (Math.sin(this._skewX) * this.skewRadius));
            // HINT: Slope = skew.y + Math.PI / 2
            handles.skewVertical.position.set(
                center.x + (-Math.sin(this._skewY) * this.skewRadius),
                center.y + (Math.cos(this._skewY) * this.skewRadius));

            this.wireframe
                .beginFill(this.wireframeStyle.color)
                .drawCircle(center.x, center.y, this.wireframeStyle.thickness * 2)
                .endFill();
            this.wireframe
                .moveTo(center.x, center.y)
                .lineTo(handles.skewHorizontal.x, handles.skewHorizontal.y)
                .moveTo(center.x, center.y)
                .lineTo(handles.skewVertical.x, handles.skewVertical.y);
        }

        // Update transforms
        for (const handleName in handles)
        {
            let rotation = this.groupBounds.rotation;

            if (handleName === 'skewHorizontal')
            {
                rotation = this._skewX;
            }
            else if (handleName === 'skewVertical')
            {
                rotation = this._skewY;
            }

            const handle: TransformerHandle = handles[handleName];

            handle.rotation = rotation;
            handle.getBounds(false, tempRect);
        }
    }

    /**
     * Called on the `pointerdown` event. You must call the super implementation.
     *
     * @param e
     */
    protected onPointerDown(e: InteractionEvent): void
    {
        this._pointerDown = true;
        this._pointerDragging = false;

        e.stopPropagation();
    }

    /**
     * Called on the `pointermove` event. You must call the super implementation.
     *
     * @param e
     */
    protected onPointerMove(e: InteractionEvent): void
    {
        if (!this._pointerDown)
        {
            return;
        }

        const lastPointerPosition = this._pointerPosition;
        const currentPointerPosition = e.data.getLocalPosition(this, tempPoint);

        const cx = currentPointerPosition.x;
        const cy = currentPointerPosition.y;

        // Translate group by difference
        if (this._pointerDragging && this.translateEnabled)
        {
            const delta = currentPointerPosition;

            delta.x -= lastPointerPosition.x;
            delta.y -= lastPointerPosition.y;

            this.translateGroup(delta);
        }

        this._pointerPosition.x = cx;
        this._pointerPosition.y = cy;
        this._pointerDragging = true;

        e.stopPropagation();
    }

    /**
     * Called on the `pointerup` and `pointerupoutside` events. You must call the super implementation.
     *
     * @param e
     */
    protected onPointerUp(e: InteractionEvent): void
    {
        this._pointerDragging = false;
        this._pointerDown = false;

        e.stopPropagation();
    }

    /**
     * Applies the given transformation matrix {@code delta} to all the display-objects in the group.
     *
     * @param delta - transformation matrix
     * @param skipUpdate - whether to skip updating the group-bounds after applying the transform
     */
    private prependTransform(delta: Matrix, skipUpdate = false): void
    {
        const group = this.group;

        for (let i = 0, j = group.length; i < j; i++)
        {
            multiplyTransform(group[i], delta, false);
        }

        if (!skipUpdate)
        {
            this.updateGroupBounds();
        }
    }

    /**
     * Recalculates {@code this.groupBounds} at the same angle.
     *
     * @param rotation - override the group's rotation
     */
    private updateGroupBounds(rotation: number = this.groupBounds.rotation): void
    {
        Transformer.calculateGroupOrientedBounds(this.group, rotation, this.groupBounds);
    }

    /**
     * Snaps the given {@code angle} to one of the snapping angles, if possible.
     *
     * @param angle - the input angle
     * @param snapTolerance - the maximum difference b/w the given angle & a snapping angle
     * @param snaps - the snapping angles
     * @returns the snapped angle
     */
    private snapAngle(angle: number, snapTolerance: number, snaps?: number[]): number
    {
        angle = angle % (Math.PI * 2);

        if (!snaps || snaps.length === 1 || !snapTolerance)
        {
            return angle;
        }

        for (let i = 0, j = snaps.length; i < j; i++)
        {
            if (Math.abs(angle - snaps[i]) <= snapTolerance)
            {
                return snaps[i];
            }
        }

        return angle;
    }

    /**
     * Calculates the positions of the four corners of the display-object. The quadrilateral formed by
     * these points will be the tightest fit around it.
     *
     * @param displayObject - The display object whose corners are to be calculated
     * @param transform - The transform applied on the display-object. By default, this is its world-transform
     * @param corners - Optional array of four points to put the result into
     * @param index - Optional index into "corners"
     */
    static calculateTransformedCorners(
        displayObject: DisplayObject,
        transform: Matrix = displayObject.worldTransform,
        corners?: Point[],
        index = 0,
    ): Point[]
    {
        const localBounds = displayObject.getLocalBounds();

        // Don't modify transforms
        displayObject.getBounds();

        corners = corners || [new Point(), new Point(), new Point(), new Point()];
        corners[index].set(localBounds.x, localBounds.y);
        corners[index + 1].set(localBounds.x + localBounds.width, localBounds.y);
        corners[index + 2].set(localBounds.x + localBounds.width, localBounds.y + localBounds.height);
        corners[index + 3].set(localBounds.x, localBounds.y + localBounds.height);

        transform.apply(corners[index], corners[index]);
        transform.apply(corners[index + 1], corners[index + 1]);
        transform.apply(corners[index + 2], corners[index + 2]);
        transform.apply(corners[index + 3], corners[index + 3]);

        return corners;
    }

    /**
     * Calculates the oriented bounding box of the display-object. This would not bending with any skew
     * applied on the display-object, i.e. it is guaranteed to be rectangular.
     *
     * @param displayObject
     * @param bounds - the bounds instance to set
     */
    static calculateOrientedBounds(displayObject: DisplayObject, bounds?: OrientedBounds): OrientedBounds
    {
        const parent = !displayObject.parent ? displayObject.enableTempParent() : displayObject.parent;

        displayObject.updateTransform();
        displayObject.disableTempParent(parent);

        // Decompose displayObject.worldTransform to get its (world) rotation
        decomposeTransform(tempTransform, displayObject.worldTransform);

        tempTransform.updateLocalTransform();

        const angle = tempTransform.rotation;
        const corners = Transformer.calculateTransformedCorners(displayObject, displayObject.worldTransform, tempCorners);

        // Calculate centroid, which is our center of rotatation
        const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
        const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;

        // Unrotation matrix
        const matrix = tempMatrix
            .identity()
            .translate(-cx, -cy)
            .rotate(-tempTransform.rotation)
            .translate(cx, cy);

        // Calculate unrotated corners
        matrix.apply(corners[0], corners[0]);
        matrix.apply(corners[1], corners[1]);
        matrix.apply(corners[2], corners[2]);
        matrix.apply(corners[3], corners[3]);

        bounds = bounds || new OrientedBounds();
        bounds.rotation = angle;
        bounds.innerBounds.x = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
        bounds.innerBounds.y = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
        bounds.innerBounds.width = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x) - bounds.innerBounds.x;
        bounds.innerBounds.height = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y) - bounds.innerBounds.y;

        return bounds;
    }

    /**
     * Calculates the oriented bounding box of a group of display-objects at a specific angle.
     *
     * @param group
     * @param rotation
     * @param bounds
     * @param skipUpdate
     */
    static calculateGroupOrientedBounds(
        group: DisplayObject[],
        rotation: number,
        bounds?: OrientedBounds,
        skipUpdate = false,
    ): OrientedBounds
    {
        const groupLength = group.length;
        const frames = pointPool.allocateArray(groupLength * 4);// Zero allocations!

        // Calculate display-object frame vertices
        for (let i = 0; i < groupLength; i++)
        {
            const displayObject = group[i];

            // Update worldTransform
            if (!skipUpdate)
            {
                const parent = !displayObject.parent ? displayObject.enableTempParent() : displayObject.parent;

                displayObject.updateTransform();
                displayObject.disableTempParent(parent);
            }

            Transformer.calculateTransformedCorners(displayObject, displayObject.worldTransform, frames, i * 4);
        }

        // Unrotation matrix
        const matrix = tempMatrix
            .identity()
            .rotate(-rotation);
        let minX = Number.MAX_VALUE;
        let minY = Number.MAX_VALUE;
        let maxX = -Number.MAX_VALUE;
        let maxY = -Number.MAX_VALUE;

        // Unrotate all frame vertices, calculate minX, minY, maxX, maxY for innerBounds
        for (let i = 0, j = frames.length; i < j; i++)
        {
            const point = frames[i];

            matrix.apply(point, point);

            const x = point.x;
            const y = point.y;

            minX = x < minX ? x : minX;
            minY = y < minY ? y : minY;
            maxX = x > maxX ? x : maxX;
            maxY = y > maxY ? y : maxY;
        }

        pointPool.releaseArray(frames);

        bounds = bounds || new OrientedBounds();
        bounds.innerBounds.x = minX;
        bounds.innerBounds.y = minY;
        bounds.innerBounds.width = maxX - minX;
        bounds.innerBounds.height = maxY - minY;
        bounds.rotation = rotation;

        matrix.applyInverse(bounds.center, tempPoint);
        bounds.center.copyFrom(tempPoint);

        return bounds;
    }
}