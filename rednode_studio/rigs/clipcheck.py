"""Burned pixels: the share of a picture clipped to pure white or pure black.

A sampler and scheduler pair that runs too hot shows up here before it shows up to
the eye: a sound render clips a few percent, a burned one tens of percent. Anime art
clips its highlights on purpose, so the number is a hint, never a verdict.
"""
import torch

WHITE = 0.98
BLACK = 0.02
WARN = 0.10      # strictly above this the run log says so


def burn_fraction(image):
    """The share of pixels whose every colour channel sits at pure white or pure black.
    `image` is ComfyUI's B x H x W x C float tensor in 0..1 (a batch counts every
    picture); anything that is not a picture gives 0.0."""
    if not torch.is_tensor(image) or image.ndim != 4 or image.shape[-1] < 3:
        return 0.0
    rgb = image[..., :3].detach().float()
    white = (rgb >= WHITE).all(dim=-1)
    black = (rgb <= BLACK).all(dim=-1)
    return float((white | black).float().mean().cpu())


def burn_note(image):
    """One run-log line for the picture, and whether it deserves a warning."""
    f = burn_fraction(image)
    text = "Clipped %.1f%%" % (f * 100.0)
    if f > WARN + 1e-6:
        text += (", which may be burned: check the sampler and scheduler (an anime "
                 "render can clip this much on purpose)")
    return text, f > WARN + 1e-6
