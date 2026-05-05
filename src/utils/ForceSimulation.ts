import * as d3 from 'd3';
import { config } from '../config/config';
import type { PromptPoint } from '../types/embedding-types';

export interface ForceSimulationOptions {
    // Simulation strength (0-1)
    strength?: number;
    // How much to decay the simulation over time (0-1)
    alphaDecay?: number;
    // How quickly points should move toward their target (0-1)
    velocityDecay?: number;
    // Custom radius calculation function
    radiusFunction?: (d: PromptPoint) => number;
    // Early stopping threshold for Safari optimization
    alphaMin?: number;
    // Maximum iterations for Safari performance
    maxIterations?: number;
}

export class PointForceSimulation {
    private simulation: d3.Simulation<PromptPoint, undefined> | null = null;
    private options: ForceSimulationOptions;
    private defaultRadius = 10;
    private isRunning = false;
    private onTickCallback: (() => void) | null = null;
    private onEndCallback: (() => void) | null = null;
    private iterationCount = 0;

    constructor(options: ForceSimulationOptions) {
        this.options = {
            strength: 0.035,
            alphaDecay: 0.25,
            velocityDecay: 0.45,
            alphaMin: 0.001,
            maxIterations: 300,
            ...options
        };
    }

    updateSimulation(points: PromptPoint[]): void {
        if (this.simulation) {
            this.simulation.nodes(points);
            this.iterationCount = 0; // Reset iteration count for new simulation
            this.simulation.alpha(1).restart();
            return;
        }

        // Create new simulation
        this.simulation = d3.forceSimulation<PromptPoint>(points)
            .alphaDecay(this.options.alphaDecay || 0.2)
            .velocityDecay(this.options.velocityDecay || 0.3)
            .alphaMin(this.options.alphaMin || 0.001);

        this.updateForces();

        // Set up tick callback with early stopping for Safari optimization
        this.simulation.on('tick', () => {
            this.iterationCount++;

            // Early stopping conditions for performance optimization
            const alpha = this.simulation?.alpha() || 0;
            const shouldStop = alpha < (this.options.alphaMin || 0.001) ||
                             this.iterationCount >= (this.options.maxIterations || 300);

            if (shouldStop) {
                this.stop();
                // Call end callback when simulation naturally ends
                if (this.onEndCallback) {
                    this.onEndCallback();
                }
                return;
            }

            // Call tick callback for each iteration
            if (this.onTickCallback) {
                this.onTickCallback();
            }
        });

        this.iterationCount = 0;
        this.simulation.alpha(1).restart();
        this.isRunning = true;
    }

    onTick(callback: () => void): void {
        this.onTickCallback = callback;
    }

    onEnd(callback: () => void): void {
        this.onEndCallback = callback;
    }

    updateOptions(options: Partial<ForceSimulationOptions>): void {
        this.options = { ...this.options, ...options };
        this.updateForces();

        if (this.simulation) {
            this.simulation.alpha(1).restart();
            this.isRunning = true;
        }
    }

    /**
     * Update the forces applied to the simulation
     */
    private updateForces(): void {
        if (!this.simulation) return;

        // Configure radius function
        const getRadius = this.options.radiusFunction ||
            (() => config.layout.scatterDotRadius || this.defaultRadius);

        // Remove old forces
        this.simulation.force('collision', null);
        this.simulation.force('x', null);
        this.simulation.force('y', null);

        // Add collision force to prevent overlapping
        this.simulation.force('collision',
            d3.forceCollide<PromptPoint>(d => getRadius(d))
                .strength(this.options.strength || 0.7)
        );

        this.simulation.force('x',
            d3.forceX<PromptPoint>(d => d.x)
                .strength(0.1)
        );

        this.simulation.force('y',
            d3.forceY<PromptPoint>(d => d.y)
                .strength(0.1)
        );
    }

    isSimulationRunning(): boolean {
        return this.isRunning;
    }

    stop(): void {
        if (this.simulation) {
            this.simulation.stop();
            this.isRunning = false;
        }
    }
} 