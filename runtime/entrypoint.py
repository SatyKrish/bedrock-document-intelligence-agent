import control_plane
from guard import install

install(control_plane)
if __name__ == "__main__":
    control_plane.serve()
