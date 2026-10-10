import pytest
from app.config import Settings


# def test_settings_port_custom():
#     s = Settings(PORT=9090)
#     assert s.PORT == 9090


# def test_settings_port_string():
#     s = Settings(PORT="8088")
#     assert s.PORT == 8088


def test_settings_port_empty_fallback():
    s = Settings(PORT="")
    assert s.PORT == 8080


def test_settings_port_whitespace_fallback():
    s = Settings(PORT="   ")
    assert s.PORT == 8080


def test_settings_port_none_fallback():
    s = Settings(PORT=None)
    assert s.PORT == 8080


def test_settings_port_invalid_string_fallback():
    s = Settings(PORT="invalid_port")
    assert s.PORT == 8080
