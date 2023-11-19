import requests
import time

urls = [
    "https://f0rest-rank-api.glitch.me/getRank/olofmeister",
    "https://f0rest-rank-api.glitch.me/getRank/f0rest"
]

while True:
    for url in urls:
        response = requests.get(url)
        if response.status_code == 200:
            print(response.json())  # or whatever processing you want to do with the data
        else:
            print(f"Failed to retrieve data from {url}. Status code: {response.status_code}")

    time.sleep(240)  # wait for 4 minutes after pinging both URLs
