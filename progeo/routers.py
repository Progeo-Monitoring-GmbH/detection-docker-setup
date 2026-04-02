from rest_framework.routers import DefaultRouter


class CustomRouter(DefaultRouter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    @staticmethod
    def get_default_base_name(viewset):
        # Override the default base name to include 'account'
        return f'{viewset.__name__.lower()}-account'
