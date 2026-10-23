from unittest import mock

from vision.pose import resolve_device


def test_auto_uses_gpu_when_cuda_available():
    with mock.patch("torch.cuda.is_available", return_value=True):
        assert resolve_device("auto") == 0


def test_auto_uses_cpu_without_cuda():
    with mock.patch("torch.cuda.is_available", return_value=False):
        assert resolve_device("auto") == "cpu"
        assert resolve_device("AUTO") == "cpu"


def test_explicit_gpu_falls_back_to_cpu_without_cuda():
    with mock.patch("torch.cuda.is_available", return_value=False):
        assert resolve_device(0) == "cpu"


def test_explicit_values_pass_through():
    with mock.patch("torch.cuda.is_available", return_value=True):
        assert resolve_device(0) == 0
        assert resolve_device("cpu") == "cpu"
