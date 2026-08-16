"""
weighted_heatmap.py

Utilities for creating heatmaps from weighted 2D points.

Points are expected in the form:

    [(x, y, weight), ...]

where x and y are normally in [0, 1].

Main model:

    heat(x) = sum_i weight_i * K(distance(x, point_i))

The default kernel is Gaussian:

    K(d) = exp(-d^2 / (2 * sigma^2))

Example
-------
    from weighted_heatmap import weighted_gaussian_heatmap

    points = [
        (0.20, 0.30, 0.8),
        (0.21, 0.31, 0.9),
        (0.25, 0.28, 0.7),
        (0.75, 0.70, 0.2),
    ]

    result = weighted_gaussian_heatmap(
        points,
        resolution=300,
        sigma=0.04,
    )

    result.plot()
"""

from dataclasses import dataclass
from typing import Iterable, Optional, Tuple

import numpy as np


# ---------------------------------------------------------------------------
# Data structure
# ---------------------------------------------------------------------------

@dataclass
class HeatmapResult:
    """
    Result returned by the heatmap functions.

    x:
        1D x coordinates corresponding to columns of the heatmaps.

    y:
        1D y coordinates corresponding to rows of the heatmaps.

    weighted_heat:
        Sum of weight * kernel at every grid location.

    density:
        Sum of kernel contributions at every grid location.

    average_weight:
        weighted_heat / density.

    cluster_strength:
        A combined measure that favors areas containing both
        many points and high weights.
    """

    x: np.ndarray
    y: np.ndarray
    weighted_heat: np.ndarray
    density: np.ndarray
    average_weight: np.ndarray
    cluster_strength: np.ndarray

    @property
    def X(self) -> np.ndarray:
        """2D meshgrid of x coordinates."""
        return np.meshgrid(self.x, self.y)[0]

    @property
    def Y(self) -> np.ndarray:
        """2D meshgrid of y coordinates."""
        return np.meshgrid(self.x, self.y)[1]

    def normalize(self, field: str = "weighted_heat") -> np.ndarray:
        """
        Normalize a heatmap field to [0, 1].

        Parameters
        ----------
        field:
            One of:
                "weighted_heat"
                "density"
                "average_weight"
                "cluster_strength"
        """
        data = getattr(self, field)

        minimum = np.nanmin(data)
        maximum = np.nanmax(data)

        if maximum <= minimum:
            return np.zeros_like(data)

        return (data - minimum) / (maximum - minimum)

    def plot(
        self,
        field: str = "weighted_heat",
        cmap: str = "hot",
        points=None,
        point_size: float = 20,
        alpha: float = 0.8,
        colorbar: bool = True,
        ax=None,
    ):
        """
        Plot a heatmap.

        Parameters
        ----------
        field:
            Which field to plot.

        cmap:
            Matplotlib colormap.

        points:
            Optional original points to overlay.

        point_size:
            Scatter point size.

        alpha:
            Scatter transparency.

        colorbar:
            Whether to show a colorbar.

        ax:
            Optional matplotlib Axes.

        Returns
        -------
        ax
        """
        import matplotlib.pyplot as plt

        if ax is None:
            _, ax = plt.subplots()

        data = getattr(self, field)

        image = ax.imshow(
            data,
            extent=(
                self.x.min(),
                self.x.max(),
                self.y.min(),
                self.y.max(),
            ),
            origin="lower",
            cmap=cmap,
            aspect="equal",
        )

        if points is not None:
            points = np.asarray(points)

            ax.scatter(
                points[:, 0],
                points[:, 1],
                s=point_size,
                c=points[:, 2],
                cmap="viridis",
                edgecolors="white",
                linewidths=0.5,
                alpha=alpha,
            )

        if colorbar:
            plt.colorbar(image, ax=ax, label=field)

        ax.set_xlabel("x")
        ax.set_ylabel("y")

        return ax


# ---------------------------------------------------------------------------
# Input handling
# ---------------------------------------------------------------------------

def _prepare_points(
    points: Iterable[Tuple[float, float, float]],
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Convert points to NumPy arrays and validate them.
    """
    points = np.asarray(points, dtype=float)

    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError(
            "points must have shape (N, 3): "
            "(x, y, weight)"
        )

    if len(points) == 0:
        raise ValueError("points cannot be empty")

    if not np.all(np.isfinite(points)):
        raise ValueError("points contain NaN or infinite values")

    xy = points[:, :2]
    weights = points[:, 2]

    return xy, weights


def _make_grid(
    resolution: int,
    bounds: Tuple[float, float, float, float],
):
    """
    Create a regular 2D grid.

    bounds = (xmin, xmax, ymin, ymax)
    """
    if resolution < 2:
        raise ValueError("resolution must be >= 2")

    xmin, xmax, ymin, ymax = bounds

    x = np.linspace(xmin, xmax, resolution)
    y = np.linspace(ymin, ymax, resolution)

    X, Y = np.meshgrid(x, y)

    return x, y, X, Y


# ---------------------------------------------------------------------------
# Kernels
# ---------------------------------------------------------------------------

def gaussian_kernel(distance_squared, sigma):
    """
    Gaussian kernel.

        exp(-d² / (2 sigma²))
    """
    if sigma <= 0:
        raise ValueError("sigma must be > 0")

    return np.exp(-distance_squared / (2.0 * sigma ** 2))


def exponential_kernel(distance, decay):
    """
    Exponential radial kernel.

        exp(-d / decay)
    """
    if decay <= 0:
        raise ValueError("decay must be > 0")

    return np.exp(-distance / decay)


def compact_kernel(distance, radius):
    """
    Compact quadratic kernel.

        (1 - d/radius)^2     d < radius
        0                     otherwise
    """
    if radius <= 0:
        raise ValueError("radius must be > 0")

    normalized_distance = distance / radius

    return np.where(
        normalized_distance < 1.0,
        (1.0 - normalized_distance) ** 2,
        0.0,
    )


# ---------------------------------------------------------------------------
# Generic heatmap calculation
# ---------------------------------------------------------------------------

def calculate_heatmap(
    points,
    resolution=300,
    bounds=(0.0, 1.0, 0.0, 1.0),
    kernel="gaussian",
    sigma=0.04,
    decay=0.04,
    radius=0.05,
    cluster_factor=1.0,
):
    """
    Calculate a weighted spatial heatmap.

    Parameters
    ----------
    points:
        Iterable of (x, y, weight).

    resolution:
        Number of pixels along each dimension.

    bounds:
        (xmin, xmax, ymin, ymax)

    kernel:
        "gaussian", "exponential", or "compact"

    sigma:
        Gaussian bandwidth.

    decay:
        Exponential decay length.

    radius:
        Radius of compact kernel.

    cluster_factor:
        Controls how strongly point density affects cluster_strength.

    Returns
    -------
    HeatmapResult
    """
    xy, weights = _prepare_points(points)

    x, y, X, Y = _make_grid(
        resolution,
        bounds,
    )

    weighted_heat = np.zeros_like(X)
    density = np.zeros_like(X)

    for (px, py), weight in zip(xy, weights):

        dx = X - px
        dy = Y - py

        distance_squared = dx * dx + dy * dy

        if kernel == "gaussian":

            K = gaussian_kernel(
                distance_squared,
                sigma,
            )

        elif kernel == "exponential":

            distance = np.sqrt(distance_squared)

            K = exponential_kernel(
                distance,
                decay,
            )

        elif kernel == "compact":

            distance = np.sqrt(distance_squared)

            K = compact_kernel(
                distance,
                radius,
            )

        else:
            raise ValueError(
                "kernel must be "
                "'gaussian', 'exponential', or 'compact'"
            )

        weighted_heat += weight * K
        density += K

    # Average weight of points contributing to each pixel.
    average_weight = (
        weighted_heat /
        np.maximum(density, 1e-12)
    )

    # Combined measure:
    #
    #   weighted heat × density^factor
    #
    # This favors regions where both:
    #   - many points contribute
    #   - their weights are high
    #
    cluster_strength = (
        weighted_heat *
        np.power(density, cluster_factor)
    )

    return HeatmapResult(
        x=x,
        y=y,
        weighted_heat=weighted_heat,
        density=density,
        average_weight=average_weight,
        cluster_strength=cluster_strength,
    )


# ---------------------------------------------------------------------------
# Convenient specialized functions
# ---------------------------------------------------------------------------

def weighted_gaussian_heatmap(
    points,
    resolution=300,
    sigma=0.04,
    bounds=(0.0, 1.0, 0.0, 1.0),
):
    """
    Weighted Gaussian KDE.

    Recommended default for most applications.
    """
    return calculate_heatmap(
        points,
        resolution=resolution,
        bounds=bounds,
        kernel="gaussian",
        sigma=sigma,
    )


def exponential_heatmap(
    points,
    resolution=300,
    decay=0.04,
    bounds=(0.0, 1.0, 0.0, 1.0),
):
    """
    Heatmap using exponential distance decay.
    """
    return calculate_heatmap(
        points,
        resolution=resolution,
        bounds=bounds,
        kernel="exponential",
        decay=decay,
    )


def compact_heatmap(
    points,
    resolution=300,
    radius=0.05,
    bounds=(0.0, 1.0, 0.0, 1.0),
):
    """
    Heatmap where points only influence locations within radius.
    """
    return calculate_heatmap(
        points,
        resolution=resolution,
        bounds=bounds,
        kernel="compact",
        radius=radius,
    )


# ---------------------------------------------------------------------------
# Peak detection
# ---------------------------------------------------------------------------

def find_peaks(
    heatmap,
    min_distance=5,
    threshold_rel=0.2,
    max_peaks=None,
):
    """
    Find local maxima in a heatmap.

    Parameters
    ----------
    heatmap:
        2D NumPy array.

    min_distance:
        Minimum number of pixels between peaks.

    threshold_rel:
        Minimum peak value as fraction of global maximum.

    max_peaks:
        Optional maximum number of peaks.

    Returns
    -------
    peaks:
        List of dictionaries:

            {
                "row": ...,
                "col": ...,
                "value": ...,
            }

    Notes
    -----
    Requires scipy.
    """
    from scipy.ndimage import maximum_filter

    if heatmap.ndim != 2:
        raise ValueError("heatmap must be 2D")

    maximum = np.max(heatmap)

    if maximum <= 0:
        return []

    threshold = maximum * threshold_rel

    size = 2 * min_distance + 1

    local_max = maximum_filter(
        heatmap,
        size=size,
        mode="nearest",
    )

    mask = (
        (heatmap == local_max) &
        (heatmap >= threshold)
    )

    rows, cols = np.where(mask)

    peaks = [
        {
            "row": int(row),
            "col": int(col),
            "value": float(heatmap[row, col]),
        }
        for row, col in zip(rows, cols)
    ]

    peaks.sort(
        key=lambda peak: peak["value"],
        reverse=True,
    )

    if max_peaks is not None:
        peaks = peaks[:max_peaks]

    return peaks


def peak_coordinates(
    result: HeatmapResult,
    field="cluster_strength",
    min_distance=5,
    threshold_rel=0.2,
    max_peaks=None,
):
    """
    Find peak coordinates in normalized coordinate space.
    """
    heatmap = getattr(result, field)

    peaks = find_peaks(
        heatmap,
        min_distance=min_distance,
        threshold_rel=threshold_rel,
        max_peaks=max_peaks,
    )

    output = []

    for peak in peaks:

        row = peak["row"]
        col = peak["col"]

        output.append({
            "x": float(result.x[col]),
            "y": float(result.y[row]),
            "value": peak["value"],
        })

    return output


# ---------------------------------------------------------------------------
# Example
# ---------------------------------------------------------------------------

if __name__ == "__main__":

    import matplotlib.pyplot as plt

    # Example data.
    #
    # First cluster:
    # several high-weight points close together.
    #
    # Second cluster:
    # several weaker points.
    #
    # Isolated point:
    # high weight, but no neighbors.

    points = np.array([
        # Strong cluster
        [0.20, 0.30, 0.9],
        [0.21, 0.31, 0.8],
        [0.23, 0.29, 1.0],
        [0.24, 0.32, 0.7],
        [0.22, 0.34, 0.9],

        # Weak cluster
        [0.70, 0.70, 0.3],
        [0.72, 0.71, 0.2],
        [0.74, 0.69, 0.25],
        [0.71, 0.74, 0.2],

        # Isolated high-weight point
        [0.50, 0.80, 1.0],
    ])

    result = weighted_gaussian_heatmap(
        points,
        resolution=400,
        sigma=0.04,
    )

    # ------------------------------------------------------------------
    # Plot weighted heat
    # ------------------------------------------------------------------

    fig, axes = plt.subplots(
        1,
        3,
        figsize=(15, 5),
    )

    result.plot(
        field="weighted_heat",
        points=points,
        ax=axes[0],
    )

    axes[0].set_title(
        "Weighted heat"
    )

    # ------------------------------------------------------------------
    # Plot average local weight
    # ------------------------------------------------------------------

    result.plot(
        field="average_weight",
        points=points,
        cmap="viridis",
        ax=axes[1],
    )

    axes[1].set_title(
        "Average local weight"
    )

    # ------------------------------------------------------------------
    # Plot cluster strength
    # ------------------------------------------------------------------

    result.plot(
        field="cluster_strength",
        points=points,
        ax=axes[2],
    )

    axes[2].set_title(
        "Cluster strength"
    )

    plt.tight_layout()
    plt.show()

    # ------------------------------------------------------------------
    # Find cluster centers
    # ------------------------------------------------------------------

    peaks = peak_coordinates(
        result,
        field="cluster_strength",
        min_distance=10,
        threshold_rel=0.15,
    )

    print("\nDetected peaks:")

    for peak in peaks:
        print(
            f"x={peak['x']:.3f}, "
            f"y={peak['y']:.3f}, "
            f"value={peak['value']:.3f}"
        )
