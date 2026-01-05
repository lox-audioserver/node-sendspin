/**
 * Two-dimensional Kalman filter for Sendspin time synchronisation.
 * Direct port of the reference Python implementation used in aiosendspin.
 */

const ADAPTIVE_FORGETTING_CUTOFF = 0.75;

class TimeElement {
  lastUpdate = 0;
  offset = 0;
  drift = 0;
}

export class SendspinTimeFilter {
  private lastUpdate = 0;
  private count = 0;

  private offset = 0;
  private drift = 0;

  private offsetCovariance = Number.POSITIVE_INFINITY;
  private offsetDriftCovariance = 0;
  private driftCovariance = 0;

  private readonly processVariance: number;
  private readonly forgetVarianceFactor: number;

  private current = new TimeElement();

  constructor(processStdDev = 0.01, forgetFactor = 1.001) {
    this.processVariance = processStdDev * processStdDev;
    this.forgetVarianceFactor = forgetFactor * forgetFactor;
  }

  update(measurement: number, maxError: number, timeAdded: number): void {
    if (timeAdded === this.lastUpdate) return;

    const dt = timeAdded - this.lastUpdate;
    this.lastUpdate = timeAdded;

    const measurementVariance = maxError * maxError;

    if (this.count <= 0) {
      this.count += 1;
      this.offset = measurement;
      this.offsetCovariance = measurementVariance;
      this.drift = 0;
      this.current = { lastUpdate: this.lastUpdate, offset: this.offset, drift: this.drift };
      return;
    }

    if (this.count === 1) {
      this.count += 1;
      this.drift = (measurement - this.offset) / dt;
      this.offset = measurement;
      this.driftCovariance = (this.offsetCovariance + measurementVariance) / dt;
      this.offsetCovariance = measurementVariance;
      this.current = { lastUpdate: this.lastUpdate, offset: this.offset, drift: this.drift };
      return;
    }

    const offsetPrediction = this.offset + this.drift * dt;
    const dtSquared = dt * dt;
    const driftProcessVariance = 0;
    let newDriftCovariance = this.driftCovariance + driftProcessVariance;
    let newOffsetDriftCovariance = this.offsetDriftCovariance + this.driftCovariance * dt;
    const offsetProcessVariance = dt * this.processVariance;
    let newOffsetCovariance =
      this.offsetCovariance +
      2 * this.offsetDriftCovariance * dt +
      this.driftCovariance * dtSquared +
      offsetProcessVariance;

    const residual = measurement - offsetPrediction;
    const maxResidualCutoff = maxError * ADAPTIVE_FORGETTING_CUTOFF;

    if (this.count < 100) {
      this.count += 1;
    } else if (residual > maxResidualCutoff) {
      newDriftCovariance *= this.forgetVarianceFactor;
      newOffsetDriftCovariance *= this.forgetVarianceFactor;
      newOffsetCovariance *= this.forgetVarianceFactor;
    }

    const uncertainty = 1.0 / (newOffsetCovariance + measurementVariance);
    const offsetGain = newOffsetCovariance * uncertainty;
    const driftGain = newOffsetDriftCovariance * uncertainty;

    this.offset = offsetPrediction + offsetGain * residual;
    this.drift += driftGain * residual;

    this.driftCovariance = newDriftCovariance - driftGain * newOffsetDriftCovariance;
    this.offsetDriftCovariance = newOffsetDriftCovariance - driftGain * newOffsetCovariance;
    this.offsetCovariance = newOffsetCovariance - offsetGain * newOffsetCovariance;

    this.current = { lastUpdate: this.lastUpdate, offset: this.offset, drift: this.drift };
  }

  computeServerTime(clientTime: number): number {
    const dt = clientTime - this.current.lastUpdate;
    const offset = Math.round(this.current.offset + this.current.drift * dt);
    return clientTime + offset;
  }

  computeClientTime(serverTime: number): number {
    return Math.round(
      (serverTime - this.current.offset + this.current.drift * this.current.lastUpdate) /
        (1 + this.current.drift),
    );
  }

  reset(): void {
    this.count = 0;
    this.offset = 0;
    this.drift = 0;
    this.offsetCovariance = Number.POSITIVE_INFINITY;
    this.offsetDriftCovariance = 0;
    this.driftCovariance = 0;
    this.current = new TimeElement();
  }

  get isSynchronized(): boolean {
    return this.count >= 2 && Number.isFinite(this.offsetCovariance);
  }

  get error(): number {
    return Math.round(Math.sqrt(this.offsetCovariance));
  }

  get covariance(): number {
    return Math.round(this.offsetCovariance);
  }

  get offsetUs(): number {
    return this.offset;
  }
}
